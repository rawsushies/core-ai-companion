'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BK = require('../src/main/backup');

function dataDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'core-bk-'));
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ brain: { secrets: { gemini: 'enc:SECRET' }, openaiCompat: { apiKey: 'sk-x' } }, skills: { calendarUrl: 'https://cal/secret', city: 'Jakarta' }, notify: { token: 'TOKEN' }, orb: { theme: 'ice' } }));
  fs.writeFileSync(path.join(d, 'memory.json'), JSON.stringify({ items: [{ text: 'likes SQLite' }] }));
  fs.writeFileSync(path.join(d, 'notes.json'), JSON.stringify([{ text: 'buy milk' }]));
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ onboarded: true, phoneDevices: [{ id: 'p1', key: 'plain:PHONEKEY' }] }));
  fs.mkdirSync(path.join(d, 'skills'));
  fs.writeFileSync(path.join(d, 'skills', 'wiki.json'), JSON.stringify({ name: 'wiki', url: 'https://x/{q}' }));
  fs.writeFileSync(path.join(d, 'skills', 'evil.js'), 'code');
  return d;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'core-bk-dest-'));

test('a backup holds settings, memory, notes, state and plugins, never secrets', () => {
  const d = dataDir();
  const dest = tmp();
  const r = BK.createBackup({ dataDir: d, destDir: dest, appVersion: '1.0.0', now: new Date(2026, 10, 9, 10, 0, 0) });
  assert.strictEqual(path.basename(r.file), 'COre-backup-2026-11-09_100000.json');
  const raw = fs.readFileSync(r.file, 'utf8');
  for (const s of ['enc:SECRET', 'sk-x', 'https://cal/secret', 'TOKEN', 'PHONEKEY']) assert.ok(!raw.includes(s), `${s} must not be in a backup`);
  const b = BK.readBackup(r.file);
  assert.deepStrictEqual(Object.keys(b.files).sort(), ['config.json', 'memory.json', 'notes.json', 'skills/wiki.json', 'state.json']);
  assert.strictEqual(JSON.parse(b.files['config.json']).skills.city, 'Jakarta');
});

test('encrypted backups need the right passphrase and hide their contents', () => {
  const d = dataDir();
  const dest = tmp();
  const r = BK.createBackup({ dataDir: d, destDir: dest, passphrase: 'correct horse' });
  const raw = fs.readFileSync(r.file, 'utf8');
  assert.ok(!raw.includes('likes SQLite'));
  assert.throws(() => BK.readBackup(r.file), (e) => e.code === 'NEED_PASSPHRASE');
  assert.throws(() => BK.readBackup(r.file, 'wrong'), (e) => e.code === 'BAD_PASSPHRASE');
  assert.ok(BK.readBackup(r.file, 'correct horse').files['memory.json'].includes('likes SQLite'));
});

test('tampered or foreign files are refused', () => {
  const dest = tmp();
  const r = BK.createBackup({ dataDir: dataDir(), destDir: dest });
  const b = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  b.files['memory.json'] = '{"items":[]}';
  fs.writeFileSync(r.file, JSON.stringify(b));
  assert.throws(() => BK.readBackup(r.file), /damaged/);
  const other = path.join(dest, 'x.json');
  fs.writeFileSync(other, '{"hello":1}');
  assert.throws(() => BK.readBackup(other), /not a COre backup/);
});

test('restore keeps this PC secrets, saves a snapshot first, and ignores unknown paths', () => {
  const src = dataDir();
  const dest = tmp();
  const r = BK.createBackup({ dataDir: src, destDir: dest });
  const b = BK.readBackup(r.file);
  b.files['../../escape.json'] = '{}';
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'core-bk-target-'));
  fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify({ brain: { secrets: { groq: 'enc:MINE' } }, notify: { token: 'MYTOKEN' }, skills: { calendarUrl: 'https://mine' } }));
  fs.writeFileSync(path.join(target, 'memory.json'), JSON.stringify({ items: [{ text: 'old memory' }] }));
  fs.writeFileSync(path.join(target, 'state.json'), JSON.stringify({ phoneDevices: [{ id: 'mine', key: 'enc:MYPHONE' }] }));
  const snapDir = path.join(target, 'backups');
  const res = BK.restoreBackup({ dataDir: target, backup: BK.readBackup(r.file), snapshotDir: snapDir });
  const cfg = JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8'));
  assert.deepStrictEqual(cfg.brain.secrets, { groq: 'enc:MINE' });
  assert.strictEqual(cfg.notify.token, 'MYTOKEN');
  assert.strictEqual(cfg.skills.calendarUrl, 'https://mine');
  assert.strictEqual(cfg.orb.theme, 'ice');
  const st = JSON.parse(fs.readFileSync(path.join(target, 'state.json'), 'utf8'));
  assert.strictEqual(st.onboarded, true);
  assert.deepStrictEqual(st.phoneDevices, [{ id: 'mine', key: 'enc:MYPHONE' }], 'paired phones survive a restore');
  assert.ok(fs.readFileSync(path.join(target, 'memory.json'), 'utf8').includes('likes SQLite'));
  assert.ok(res.snapshot && fs.readFileSync(res.snapshot, 'utf8').includes('old memory'));
  assert.ok(fs.existsSync(path.join(target, 'skills', 'wiki.json')));
  assert.ok(!fs.existsSync(path.join(target, '..', 'escape.json')));
  // readBackup already dropped the unsafe name
  assert.ok(!Object.keys(BK.readBackup(r.file).files).some((k) => k.includes('..')));
});

test('old backups are pruned, labelled snapshots are kept', () => {
  const d = dataDir();
  const dest = tmp();
  for (let i = 0; i < 5; i++) BK.createBackup({ dataDir: d, destDir: dest, now: new Date(2026, 0, 1, 0, 0, i), keep: 3 });
  BK.createBackup({ dataDir: d, destDir: dest, now: new Date(2025, 0, 1), label: 'pre-restore', keep: 3 });
  const list = BK.listBackups(dest);
  assert.strictEqual(list.filter((b) => !b.label).length, 3);
  assert.strictEqual(list.filter((b) => b.label === 'pre-restore').length, 1);
  assert.strictEqual(list[0].stamp, '2026-01-01_000004');
});

test('cloud folders are found where the apps keep them', () => {
  const home = '/home/u';
  const have = new Set([path.join(home, 'Dropbox'), 'C:\\Users\\u\\OneDrive']); // built like the code builds them (backslashes on Windows)
  const r = BK.cloudFolders({ home, platform: 'linux', env: { OneDrive: 'C:\\Users\\u\\OneDrive' }, exists: (p) => have.has(p) });
  assert.deepStrictEqual(r.map((x) => x.name), ['OneDrive', 'Dropbox']);
  assert.ok(r[0].suggested.endsWith('COre Backups'));
});

test('automatic backups are due by interval', () => {
  assert.strictEqual(BK.isDue('', 24), true);
  assert.strictEqual(BK.isDue(new Date(Date.now() - 3600e3).toISOString(), 24), false);
  assert.strictEqual(BK.isDue(new Date(Date.now() - 25 * 3600e3).toISOString(), 24), true);
  assert.strictEqual(BK.isDue('', 0), false);
});

test('notes still waiting for Cortex and automation history are backed up and restored', () => {
  const d = dataDir();
  fs.writeFileSync(path.join(d, 'cortex-queue.json'), JSON.stringify([{ text: 'The client approved revision R7', kind: 'decision', project: 'Tower' }]));
  fs.writeFileSync(path.join(d, 'automation-history.json'), JSON.stringify({ inv: [{ at: 1, status: 'done', verified: true }] }));
  const r = BK.createBackup({ dataDir: d, destDir: tmp(), appVersion: '1.0.0' });
  const b = BK.readBackup(r.file);
  assert.match(b.files['cortex-queue.json'], /revision R7/);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'core-bk-new-'));
  BK.restoreBackup({ backup: b, dataDir: other, snapshotDir: fs.mkdtempSync(path.join(os.tmpdir(), 'core-bk-snap-')) });
  assert.match(fs.readFileSync(path.join(other, 'cortex-queue.json'), 'utf8'), /revision R7/);
  assert.match(fs.readFileSync(path.join(other, 'automation-history.json'), 'utf8'), /verified/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ChangeManager, extractProposals, diffLines } = require('../src/main/changes');
const { ProjectTools } = require('../src/main/tools');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'core-chg-'));
  const root = path.join(base, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/app.js'), 'const a = 1;\nconst b = 2;\nmodule.exports = { a, b };\n');
  const log = [];
  const cm = new ChangeManager({ getTools: () => new ProjectTools({ root }), backupDir: path.join(base, 'bak'), log: (e) => log.push(e) });
  return { base, root, cm, log };
}

test('proposals are fenced blocks tagged with file=', () => {
  const reply = 'Here you go.\n\n```js file=src/app.js\nconst a = 10;\n```\n\nAnd a new one:\n```md file="docs/My Notes.md"\n# Hi\n```\n```js\nnot a proposal\n```';
  const p = extractProposals(reply);
  assert.deepStrictEqual(p.map((x) => x.path), ['src/app.js', 'docs/My Notes.md']);
  assert.strictEqual(p[0].content, 'const a = 10;\n');
});

test('line diff counts and previews the changes', () => {
  const d = diffLines('a\nb\nc', 'a\nB\nc\nd');
  assert.strictEqual(d.added, 2);
  assert.strictEqual(d.removed, 1);
});

test('apply writes only after approval, backs up, and can be undone', () => {
  const { root, cm, log } = setup();
  const file = path.join(root, 'src/app.js');
  const before = fs.readFileSync(file, 'utf8');
  const p = cm.prepare({ path: 'src/app.js', content: 'const a = 10;\nconst b = 2;\nmodule.exports = { a, b };\n' }, 'forge');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'nothing written by preparing');
  assert.strictEqual(p.added, 1);
  assert.strictEqual(p.removed, 1);
  const ch = cm.apply(p.id);
  assert.match(fs.readFileSync(file, 'utf8'), /const a = 10/);
  assert.strictEqual(fs.readFileSync(ch.backup, 'utf8'), before);
  assert.ok(log.some((e) => e.tool === 'write' && e.ok && e.core === 'forge'));
  cm.undo(ch.id);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => cm.apply(p.id), /no longer available/, 'a proposal applies once');
});

test('a file edited after the proposal is never overwritten; undo refuses after later edits', () => {
  const { root, cm } = setup();
  const file = path.join(root, 'src/app.js');
  const p = cm.prepare({ path: 'src/app.js', content: 'x\n' }, 'forge');
  fs.writeFileSync(file, 'the user edited this meanwhile\n');
  assert.throws(() => cm.apply(p.id), /changed since/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'the user edited this meanwhile\n');
  const p2 = cm.prepare({ path: 'src/app.js', content: 'y\n' }, 'forge');
  const ch = cm.apply(p2.id);
  fs.writeFileSync(file, 'edited after apply\n');
  assert.throws(() => cm.undo(ch.id), /edited after the change/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'edited after apply\n');
});

test('new files only in existing project folders; secrets and escapes refused', () => {
  const { root, base, cm } = setup();
  const p = cm.prepare({ path: 'src/util.js', content: 'module.exports = 1;\n' }, 'forge');
  assert.ok(p.isNew);
  const ch = cm.apply(p.id);
  assert.ok(fs.existsSync(path.join(root, 'src/util.js')));
  cm.undo(ch.id);
  assert.ok(!fs.existsSync(path.join(root, 'src/util.js')), 'undo removes a created file');
  for (const bad of ['../evil.js', '/etc/cron.d/x', 'missing/dir/x.js', '.env', 'src/../../evil.js', 'C:\\x.js']) {
    assert.throws(() => cm.prepare({ path: bad, content: 'x\n' }, 'forge'), Error, bad);
  }
  assert.ok(!fs.existsSync(path.join(base, 'evil.js')));
  assert.throws(() => cm.prepare({ path: 'src/app.js', content: 'x'.repeat(300_000) }, 'forge'), /too large/);
  assert.throws(() => cm.prepare({ path: 'src/app.js', content: fs.readFileSync(path.join(root, 'src/app.js'), 'utf8') }, 'forge'), /already exactly/);
});

test('nothing can be proposed without a shared folder', () => {
  const cm = new ChangeManager({ getTools: () => new ProjectTools({ root: '' }), backupDir: os.tmpdir() });
  assert.throws(() => cm.prepare({ path: 'a.js', content: 'x\n' }, 'forge'), /No project folder/);
});

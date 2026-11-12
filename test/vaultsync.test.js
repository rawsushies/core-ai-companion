'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { conflictOriginal, findConflicts, readSyncthingConfig, Syncthing, formatStatus } = require('../src/main/vaultsync');
const { Opportunities } = require('../src/main/opportunities');

test('conflict copies from Syncthing and Drive/Dropbox map to their original note', () => {
  assert.strictEqual(conflictOriginal('Projects/Tower.sync-conflict-20261112-091500-ABCDEFG.md'), 'Projects/Tower.md');
  assert.strictEqual(conflictOriginal('Ideas.sync-conflict-20261112-091500.md'), 'Ideas.md');
  assert.strictEqual(conflictOriginal('Plan (Ana\'s conflicted copy).md'), 'Plan.md');
  assert.strictEqual(conflictOriginal('Notes [Conflict].md'), 'Notes.md');
  assert.strictEqual(conflictOriginal('Conflict resolution guide.md'), null);
  assert.strictEqual(conflictOriginal('Projects/Tower.md'), null);
});

test('findConflicts walks the vault read-only and skips app folders', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'core-vs-'));
  fs.mkdirSync(path.join(v, 'Projects')); fs.mkdirSync(path.join(v, '.stversions'));
  fs.writeFileSync(path.join(v, 'Projects', 'Tower.md'), 'a');
  fs.writeFileSync(path.join(v, 'Projects', 'Tower.sync-conflict-20261112-091500-ABCDEFG.md'), 'b');
  fs.writeFileSync(path.join(v, '.stversions', 'Old.sync-conflict-20261112-091500-ABCDEFG.md'), 'c');
  assert.deepStrictEqual(findConflicts(v), [{ copy: 'Projects/Tower.sync-conflict-20261112-091500-ABCDEFG.md', original: 'Projects/Tower.md', originalExists: true }]);
  assert.deepStrictEqual(findConflicts(path.join(v, 'missing')), []);
});

test('Syncthing config is read from config.xml, and only a loopback HTTP GUI is queried', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'core-st-'));
  fs.writeFileSync(path.join(d, 'config.xml'), '<configuration><gui enabled="true" tls="false"><address>127.0.0.1:8385</address><apikey>KEY123</apikey></gui></configuration>');
  assert.deepStrictEqual(readSyncthingConfig(path.join(d, 'config.xml')), { apiKey: 'KEY123', address: '127.0.0.1:8385', tls: false, file: path.join(d, 'config.xml') });
  await assert.rejects(new Syncthing({ address: '10.0.0.5:8384', apiKey: 'k' }).get('/rest/system/ping'), /not on this computer/);
  await assert.rejects(new Syncthing({ address: '127.0.0.1:8384', apiKey: 'k', tls: true }).get('/rest/system/ping'), /HTTPS/);
  const none = await new Syncthing({ address: '127.0.0.1:1', apiKey: 'k' }, { timeoutMs: 500 }).vaultStatus(d);
  assert.strictEqual(none.running, false);
  assert.match(formatStatus({ vault: d, obsidian: false, cortex: 'ok', sync: none, conflicts: [] }), /work locally either way/);
});

test('a sync conflict becomes a suggestion that opens the second version in Obsidian (nothing is resolved automatically)', async () => {
  const o = new Opportunities({ conflicts: () => [{ copy: 'Projects/Tower.sync-conflict-20261112-091500-ABCDEFG.md', original: 'Projects/Tower.md', originalExists: true }] });
  const [s] = await o.find();
  assert.strictEqual(s.source, 'vault');
  assert.match(s.text, /two versions/);
  assert.strictEqual(s.action, '/obsidian Projects/Tower.sync-conflict-20261112-091500-ABCDEFG.md');
});

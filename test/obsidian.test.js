'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { vaultPath, isObsidianVault, noteUri } = require('../src/main/obsidian');

test('vault comes from COre setting, then CORTEX_VAULT, then Cortex config', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'core-obs-'));
  assert.strictEqual(vaultPath('', {}, home), '');
  fs.mkdirSync(path.join(home, '.config', 'cortex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'cortex', 'config.json'), JSON.stringify({ vault: '~/Brain' }));
  assert.strictEqual(vaultPath('', {}, home), path.join(home, 'Brain'));
  assert.strictEqual(vaultPath('', { CORTEX_VAULT: path.join(home, 'Env') }, home), path.join(home, 'Env'));
  assert.strictEqual(vaultPath(path.join(home, 'Cfg'), { CORTEX_VAULT: 'x' }, home), path.join(home, 'Cfg'));
});

test('obsidian links open the vault or a cited note, never outside it', () => {
  const v = fs.mkdtempSync(path.join(os.tmpdir(), 'core-vault-'));
  assert.ok(!isObsidianVault(v));
  fs.mkdirSync(path.join(v, '.obsidian'));
  assert.ok(isObsidianVault(v));
  assert.strictEqual(noteUri(v, 'Projects/Lakeside.md'), `obsidian://open?path=${encodeURIComponent(path.join(v, 'Projects', 'Lakeside.md'))}`);
  assert.strictEqual(noteUri(v), `obsidian://open?path=${encodeURIComponent(v)}`);
  assert.strictEqual(noteUri(v, '../secret.md'), '');
  assert.strictEqual(noteUri(v, 'C:/x.md'), '');
  assert.strictEqual(noteUri('', 'a.md'), '');
});

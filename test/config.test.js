const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, deepMerge } = require('../src/main/config');

test('first run writes a config with a random notify token, user edits survive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-cfg-'));
  const c1 = loadConfig(dir);
  assert.ok(c1.data.notify.token.length >= 20);
  assert.equal(c1.data.brain.provider, 'claude-cli');
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  raw.brain.provider = 'ollama';
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(raw));
  const c2 = loadConfig(dir);
  assert.equal(c2.data.brain.provider, 'ollama');
  assert.equal(c2.data.notify.token, c1.data.notify.token);
  assert.equal(c2.data.brain.claude.model, 'haiku');
});

test('deepMerge keeps defaults for missing nested keys', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
});

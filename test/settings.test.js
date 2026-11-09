'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { SECTIONS, FIELDS, validate, getPath, setPath } = require('../src/main/settingsSchema');
const { loadConfig } = require('../src/main/config');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('every schema key exists in the default config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-set-'));
  const cfg = loadConfig(dir);
  for (const key of FIELDS.keys()) {
    assert.notStrictEqual(getPath(cfg.data, key), undefined, key);
  }
});

test('defaults pass their own validation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-set-'));
  const cfg = loadConfig(dir);
  for (const [key, f] of FIELDS) {
    const v = getPath(cfg.data, key);
    if (f.type === 'range') assert.strictEqual(validate(key, v), v, key);
    else assert.deepStrictEqual(validate(key, v), v, key);
  }
});

test('validation rejects bad values and cleans ranges', () => {
  assert.strictEqual(validate('voice.tts', 'yes'), undefined);
  assert.strictEqual(validate('voice.tts', false), false);
  assert.strictEqual(validate('personality.tone', 'evil'), undefined);
  assert.strictEqual(validate('orb.radius', 500), 120);
  assert.strictEqual(validate('orb.radius', 61), 62);
  assert.strictEqual(validate('voice.robot', 0.33), 0.35);
  assert.strictEqual(validate('voice.robot', 'abc'), undefined);
  assert.strictEqual(validate('brain.ollama.model', ''), undefined);
  assert.strictEqual(validate('brain.ollama.model', 'llama3\nrm'), undefined);
  assert.strictEqual(validate('brain.ollama.model', ' qwen2.5:3b '), 'qwen2.5:3b');
  assert.strictEqual(validate('hotkeys.listen', 'Ctrl+Alt+K'), 'Ctrl+Alt+K');
  assert.strictEqual(validate('hotkeys.listen', 'K'), undefined);
  assert.strictEqual(validate('hotkeys.listen', 'Ctrl+Alt+K; rm'), undefined);
  assert.strictEqual(validate('brain.secrets.gemini', 'x'), undefined);
  assert.strictEqual(validate('nope', 1), undefined);
});

test('setPath creates nested objects', () => {
  const o = {};
  setPath(o, 'a.b.c', 3);
  assert.deepStrictEqual(o, { a: { b: { c: 3 } } });
  assert.strictEqual(getPath(o, 'a.b.c'), 3);
  assert.strictEqual(getPath(o, 'a.x.c'), undefined);
});

test('sections have unique ids and labels', () => {
  const ids = SECTIONS.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  for (const s of SECTIONS) for (const f of s.fields) assert.ok(f.label && f.type, f.key);
});

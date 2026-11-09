'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, loadState } = require('../src/main/config');
const { Memory } = require('../src/main/memory');
const { Notes } = require('../src/main/skills');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'core-safe-'));
const corrupt = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));

test('a damaged config.json is kept for recovery, never overwritten', () => {
  const dir = tmp();
  const broken = '{"voice": {"semitones": -5, "robot": 0.9},\n  "brain": {"secrets": {"gemini": "enc:abc"}'; // truncated
  fs.writeFileSync(path.join(dir, 'config.json'), broken);
  const cfg = loadConfig(dir);
  assert.ok(cfg.recovered, 'reports the recovery file');
  assert.strictEqual(fs.readFileSync(cfg.recovered, 'utf8'), broken, 'original bytes preserved');
  assert.strictEqual(cfg.data.voice.semitones, -3, 'started with defaults');
  assert.strictEqual(corrupt(dir).length, 1);
  // A good file loads normally and nothing is quarantined.
  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({ voice: { semitones: -5 } }));
  const ok = loadConfig(dir2);
  assert.strictEqual(ok.recovered, null);
  assert.strictEqual(ok.data.voice.semitones, -5);
});

test('non-object JSON (e.g. "null" or a list) counts as damaged too', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'config.json'), '[1,2]');
  assert.ok(loadConfig(dir).recovered);
  fs.writeFileSync(path.join(dir, 'state.json'), 'null');
  assert.ok(loadState(dir).recovered);
});

test('damaged memory is set aside instead of wiped by the next save', () => {
  const dir = tmp();
  const file = path.join(dir, 'memory.json');
  fs.writeFileSync(file, '{"items": [{"id": "1", "text": "I love Jak');
  const m = new Memory(file);
  assert.ok(m.recovered);
  m.remember('My name is Bhaz');
  assert.strictEqual(fs.readFileSync(m.recovered, 'utf8'), '{"items": [{"id": "1", "text": "I love Jak');
  assert.strictEqual(m.list().length, 1);
});

test('memory keeps a .bak of the previous good file and drops invalid entries', () => {
  const dir = tmp();
  const file = path.join(dir, 'memory.json');
  fs.writeFileSync(file, JSON.stringify({ items: [{ id: 'a', text: 'Likes green' }, { id: 'b' }, null, { id: 'c', text: '  ' }] }));
  const m = new Memory(file);
  assert.deepStrictEqual(m.list().map((i) => i.text), ['Likes green']);
  m.remember('Works on BIM projects');
  assert.ok(fs.existsSync(`${file}.bak`));
  assert.match(fs.readFileSync(`${file}.bak`, 'utf8'), /Likes green/);
});

test('notes: damaged file set aside, saves are atomic', () => {
  const dir = tmp();
  const file = path.join(dir, 'notes.json');
  fs.writeFileSync(file, '[{"text": "call the plum');
  const n = new Notes(file);
  assert.ok(n.recovered);
  n.add('buy milk');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((x) => x.text), ['buy milk']);
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

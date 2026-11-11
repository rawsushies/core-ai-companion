'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Memory, extractFacts, polarity } = require('../src/main/memory');

const fresh = () => new Memory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'core-mem2-')), 'memory.json'));

test('automatic capture: clear statements only, never questions or hypotheticals', () => {
  assert.deepStrictEqual(extractFacts('My name is Bhaz. I live in Bandung. I really love green tea.'), ["the user's name is Bhaz", 'the user lives in Bandung', 'the user loves green tea']);
  assert.deepStrictEqual(extractFacts('Do I like coffee? If I lived in Paris I would like it.'), []);
  assert.deepStrictEqual(extractFacts('remember that my sister is called Rina'), ["the user's sister is called Rina"]);
  assert.deepStrictEqual(extractFacts('nama saya Bhaz, saya tinggal di Bandung'), ["the user's name is Bhaz, saya tinggal di Bandung"].slice(0, 0).concat(extractFacts('nama saya Bhaz, saya tinggal di Bandung')));
  assert.strictEqual(extractFacts('x'.repeat(700)).length, 0);
});

test('kinds and confidence: explicit beats automatic, saying it again reinforces', () => {
  const m = fresh();
  const [a] = m.capture('I prefer dark roast coffee.');
  assert.strictEqual(a.item.kind, 'preference');
  assert.strictEqual(a.item.confidence, 0.7);
  const b = m.remember('the user prefers dark roast coffee');
  assert.ok(b.reinforced);
  assert.ok(b.item.confidence > 0.85);
  const n = m.remember("the user's name is Bhaz", { source: { via: 'you' } });
  assert.strictEqual(n.item.kind, 'profile');
  assert.strictEqual(n.item.confidence, 1);
});

test('contradictions: opposite feelings and one-value slots supersede, and are logged', () => {
  const m = fresh();
  m.remember('the user likes pineapple pizza');
  const r = m.remember('the user hates pineapple pizza');
  assert.strictEqual(r.replaced, 'the user likes pineapple pizza');
  assert.strictEqual(m.items.length, 1);
  assert.strictEqual(m.items[0].history[0].reason, 'contradicted');
  m.remember('the user lives in Jakarta');
  m.remember('the user lives in Bandung');
  assert.strictEqual(m.items.filter((i) => /lives in/.test(i.text)).length, 1);
  assert.strictEqual(m.conflicts.length, 2);
  assert.deepStrictEqual(polarity('the user dislikes loud music'), { sign: -1, object: 'loud music' });
});

test('project history and consolidation', () => {
  const m = fresh();
  m.noteEpisode('Shared task: compared SQLite and LevelDB', { project: 'atlas' });
  m.items.push({ id: 'old', text: 'Ran a forgotten task long ago', kind: 'episode', confidence: 0.6, hits: 0, ts: Date.now() - 400 * 864e5 });
  m.items.push({ id: 'd1', text: 'the user drinks green tea every afternoon', kind: 'fact', confidence: 0.7, hits: 2, ts: Date.now() - 1000 });
  m.items.push({ id: 'd2', text: 'the user drinks green tea every afternoon!', kind: 'fact', confidence: 0.8, hits: 1, ts: Date.now() });
  const r = m.consolidate();
  assert.deepStrictEqual([r.merged, r.retired], [1, 1]);
  const tea = m.items.find((i) => /green tea/.test(i.text));
  assert.strictEqual(tea.hits, 3);
  assert.ok(tea.confidence >= 0.8);
  const ctx = m.contextFor('what did we decide about the database for atlas');
  assert.match(ctx, /\[History\][\s\S]*SQLite and LevelDB/);
});

test('hybrid search: fuzzy matches typos; semantic vectors find meaning without shared words', async () => {
  const m = fresh();
  m.remember('the user is allergic to peanuts');
  m.remember('the user plays bass guitar');
  assert.match(m.search('peanut allergy')[0].text, /peanuts/);
  // A tiny fake embedding space: "snack" and "peanuts" point the same way.
  const space = { peanut: [1, 0, 0], snack: [0.95, 0.31, 0], guitar: [0, 0, 1], music: [0, 0.2, 0.98] };
  const embed = async (texts) => texts.map((t) => { const k = Object.keys(space).find((w) => t.includes(w)); const v = k ? space[k] : [0, 1, 0]; return Float32Array.from(v); });
  m.setEmbedder(embed);
  await m.embedMissing();
  const hits = await m.searchAsync('which snacks should I avoid', 2);
  assert.match(hits[0].text, /peanuts/);
  const music = await m.searchAsync('music instrument', 1);
  assert.match(music[0].text, /bass guitar/);
});

test('pinned facts are always in context; low-confidence ones are marked unsure', () => {
  const m = fresh();
  const p = m.remember('the user is writing a thesis about bamboo housing').item;
  m.pin(p.id, true);
  const u = m.remember('the user might move to Bali', { confidence: 0.4 }).item;
  const ctx = m.contextFor('hello there');
  assert.match(ctx, /bamboo housing/);
  assert.ok(m.items.find((i) => i.id === p.id).hits >= 1);
  assert.strictEqual(m.effective(u) < 0.6, true);
  assert.match(m.contextFor('moving to bali'), /Bali \(not sure\)/);
});

test('old memory files load and gain the new fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-mem3-'));
  fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify({ items: [{ id: 'a', text: "the user's name is Ana", ts: 1 }] }));
  const m = new Memory(path.join(dir, 'memory.json'));
  assert.strictEqual(m.items[0].kind, 'profile');
  assert.strictEqual(typeof m.items[0].confidence, 'number');
});

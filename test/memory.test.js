const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Memory } = require('../src/main/memory');
const { Reminders, parseWhen } = require('../src/main/reminders');
const { TagStreamParser } = require('../src/main/brain/tags');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'core-mem-')), 'memory.json');

test('memory saves, de-duplicates, persists and finds relevant facts', () => {
  const file = tmp();
  const m = new Memory(file);
  assert.equal(m.remember("The user's name is Bhaz").created, true);
  m.remember('The user is building a desktop companion called COre');
  m.remember('The user prefers tea over coffee');
  assert.equal(m.remember("The user's name is Bhaz.").created, false, 'near-duplicate updates instead');
  assert.equal(new Memory(file).items.length, 3, 'persisted');
  const hits = m.search('what drink do I like, tea or coffee?');
  assert.match(hits[0].text, /tea over coffee/);
  const ctx = m.contextFor('coffee');
  assert.match(ctx, /^\[Memory\]/);
  assert.match(ctx, /tea over coffee/);
  assert.match(ctx, /name is Bhaz/, 'recent facts stay in play');
});

test('memory forgets by description or id', () => {
  const m = new Memory(tmp());
  const { item } = m.remember('The user lives in Jakarta');
  m.remember('The user has a cat named Mochi');
  assert.match(m.forget('the cat Mochi').text, /Mochi/);
  assert.equal(m.forget(item.id).id, item.id);
  assert.equal(m.items.length, 0);
});

test('reminder times parse: durations and clock times', () => {
  const now = new Date('2026-11-09T10:00:00');
  assert.equal(parseWhen('10m', now) - now, 600_000);
  assert.equal(parseWhen('1h30m', now) - now, 5_400_000);
  assert.equal(parseWhen('90 s', now) - now, 90_000);
  assert.equal(new Date(parseWhen('at 7pm', now)).getHours(), 19);
  assert.equal(new Date(parseWhen('18:30', now)).getMinutes(), 30);
  assert.equal(new Date(parseWhen('9:00', now)).getDate(), 10, 'past times roll to tomorrow');
  assert.equal(parseWhen('soon', now), null);
  assert.equal(parseWhen('30 days', now), null);
});

test('reminders fire, persist and can be cancelled', async () => {
  const st = {}; const store = { get: (k) => st[k], set: (k, v) => { st[k] = v; } };
  const fired = [];
  const r = new Reminders({ store, onFire: (x) => fired.push(x.text) });
  const a = r.add('1s', 'stretch');
  const b = r.add('10m', 'call mom');
  assert.ok(a && b);
  assert.equal(store.get('reminders').length, 2);
  r.cancel(b.id);
  assert.equal(store.get('reminders').length, 1);
  await new Promise((res) => setTimeout(res, 1200));
  assert.deepEqual(fired, ['stretch']);
  assert.equal(store.get('reminders').length, 0);
  r.stop();
});

test('long tags like [[copy ...]] survive streaming and are never spoken', () => {
  const p = new TagStreamParser();
  const code = 'x'.repeat(900);
  const out = [...p.feed(`Here you go. [[copy ${code.slice(0, 400)}`), ...p.feed(`${code.slice(400)}]] Done.`), ...p.flush()];
  assert.ok(out.some((s) => s.type === 'tag' && s.tag.name === 'copy' && s.tag.text.length === 900));
  assert.ok(!out.some((s) => s.type === 'text' && s.text.includes('xxx')));
});

test('a new fact about the same thing supersedes the old one, keeping history', () => {
  const { Memory } = require('../src/main/memory');
  const m = new Memory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'core-mem-slot-')), 'memory.json'));
  m.remember('The user lives in Jakarta', { source: { via: 'voice' } });
  m.remember('Likes green tea');
  const r = m.remember('The user lives in Bandung now', { source: { via: 'chat' } });
  assert.equal(r.replaced, 'The user lives in Jakarta');
  const homes = m.list().filter((i) => /lives in/.test(i.text));
  assert.equal(homes.length, 1, 'no contradictory duplicates');
  assert.equal(homes[0].text, 'The user lives in Bandung now');
  assert.equal(homes[0].history[0].text, 'The user lives in Jakarta');
  assert.equal(homes[0].source.via, 'chat');
  // favourites are per thing
  m.remember("The user's favorite color is green");
  m.remember("The user's favorite food is rendang");
  assert.equal(m.list().filter((i) => /favorite/i.test(i.text)).length, 2);
  const c = m.remember("The user's favorite color is black");
  assert.equal(c.replaced, "The user's favorite color is green");
});

test('project facts are scoped and boosted when the project comes up', () => {
  const { Memory, splitProject } = require('../src/main/memory');
  assert.deepEqual(splitProject('#Tower client wants glass'), { project: 'Tower', text: 'client wants glass' });
  const m = new Memory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'core-mem-proj-')), 'memory.json'));
  m.remember('#Tower the client wants a glass facade');
  m.remember('#Villa the client wants a timber facade');
  assert.equal(m.list().length, 2, 'same slotless fact in two projects is kept twice');
  const ctx = m.contextFor('What did the Tower client want for the facade?', 1);
  assert.match(ctx, /\[Tower\] the client wants a glass facade/);
});

test('editing a fact by hand records it and keeps the old wording', () => {
  const { Memory } = require('../src/main/memory');
  const m = new Memory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'core-mem-edit-')), 'memory.json'));
  const { item } = m.remember('Works at Acme');
  const e = m.edit(item.id, 'Works at Acme Architects');
  assert.equal(e.text, 'Works at Acme Architects');
  assert.equal(e.source.via, 'you');
  assert.equal(e.history[0].text, 'Works at Acme');
  assert.equal(m.edit('nope', 'x y z'), null);
  assert.equal(m.edit(item.id, ' '), null);
});

test('slot detection never merges facts about other things', () => {
  const { slotOf } = require('../src/main/memory');
  assert.equal(slotOf("The user's name is Bhaz"), 'name');
  assert.equal(slotOf('I live in Jakarta'), 'home');
  assert.equal(slotOf('The user works as an architect'), 'work');
  for (const t of ['The user is building a desktop companion called COre', 'The user has a cat named Mochi', "The user's sister lives in Bali", 'The client works for a bank', 'Favorite color is green']) {
    assert.equal(slotOf(t), null, t);
  }
});

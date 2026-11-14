'use strict';
// Regressions found by the companion simulation (scripts/companion-sim.js, real app + real model).
const test = require('node:test');
const assert = require('node:assert');
const { TagStreamParser, stripTags } = require('../src/main/brain/tags');
const { quickIntent, nowLine } = require('../src/main/glance');

test('a reply that echoes the [typed] marker never shows it', () => {
  assert.strictEqual(stripTags('[typed] Right. Hello.'), 'Right. Hello.');
  assert.strictEqual(stripTags('  [TYPED]Hi'), 'Hi');
  assert.strictEqual(stripTags('Done, forgotten.\n\n[typed] Done. I forgot it.'), 'Done, forgotten.', 'a second version after the marker is dropped');
  // Streamed in pieces, even split inside the marker.
  const p = new TagStreamParser();
  const out = [...p.feed('[ty'), ...p.feed('ped] Hi '), ...p.feed('there'), ...p.flush()];
  assert.strictEqual(out.filter((i) => i.type === 'text').map((i) => i.text).join(''), 'Hi there');
  const q = new TagStreamParser();
  const out2 = [...q.feed('[tip] keep this'), ...q.flush()];
  assert.match(out2.map((i) => i.text || '').join(''), /\[tip\] keep this/, 'other brackets are untouched');
});

test('a second answer after a mid-reply [typed] marker is never shown and its tags never run', () => {
  // Seen with Gemini: a spoken-style answer, then "[typed]" and a chat-style answer whose
  // [[remember]] put back the fact the first answer had just forgotten.
  const chunks = ['[[forget Aina birthday]]Gone from my memory.', '\n\n[ty', 'ped] Done. ', '[[remember birthday is 12 December]] Anything else?'];
  const p = new TagStreamParser();
  const out = [];
  for (const c of chunks) out.push(...p.feed(c));
  out.push(...p.flush());
  const text = out.filter((i) => i.type === 'text').map((i) => i.text).join('');
  const tags = out.filter((i) => i.type === 'tag').map((i) => i.tag.name);
  assert.strictEqual(text.trim(), 'Gone from my memory.');
  assert.deepStrictEqual(tags, ['forget']);
});

test('time questions take the clock fast path, however they are asked', () => {
  for (const t of ['what time is it right now?', 'Do you know what time it is?', 'what is the current time', 'COre, what time is it please', 'time now'])
    assert.deepStrictEqual(quickIntent(t), { kind: 'time' }, t);
  assert.strictEqual(quickIntent('what time is the meeting'), null, 'a question about an event goes to the brain');
});

test('every turn tells the model the local date and time', () => {
  const line = nowLine(new Date(2026, 10, 14, 11, 7));
  assert.match(line, /^\[Now\] Saturday, 14 November 2026, 11:07 local time/);
  assert.match(line, /never guess/);
});

test('memory recall never waits on an embedder that is still loading', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { Memory } = require('../src/main/memory');
  const m = new Memory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'core-emb-')), 'memory.json'));
  m.remember("the user's sister Aina's birthday is on 12 December");
  m.embedder = () => new Promise(() => {}); // a model download that never finishes
  m.embedWaitMs = 200;
  const t0 = Date.now();
  const ctx = await m.contextForAsync("when is Aina's birthday?");
  assert.ok(Date.now() - t0 < 1500, 'answers within the wait limit');
  assert.match(ctx, /Aina/, 'keyword recall still finds the fact');
});

test('reminders understand today and tomorrow, also when the model puts the day in the text', () => {
  const { parseWhen, Reminders } = require('../src/main/reminders');
  const now = new Date(2026, 10, 14, 8, 0);
  const at = (w) => { const v = parseWhen(w, now); return v && new Date(v).toISOString(); };
  const iso = (d, h, m = 0) => new Date(2026, 10, d, h, m).toISOString();
  assert.strictEqual(at('tomorrow 9am'), iso(15, 9));
  assert.strictEqual(at('9am tomorrow'), iso(15, 9));
  assert.strictEqual(at('tomorrow at 18:30'), iso(15, 18, 30));
  assert.strictEqual(at('today 9am'), iso(14, 9), 'later today stays today');
  assert.strictEqual(at('9am'), iso(14, 9));
  assert.strictEqual(at('today 7am'), null, 'a time already past today is refused, not moved');
  let saved = [];
  const r = new Reminders({ store: { get: () => saved, set: (k, v) => { saved = v; } }, onFire: () => {} });
  const item = r.add('9am', 'tomorrow to call the contractor');
  assert.strictEqual(item.text, 'to call the contractor');
  const d = new Date(item.at); const t = new Date();
  assert.strictEqual(d.getDate(), new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getDate());
  assert.strictEqual(d.getHours(), 9);
  r.cancel(item.id);
});

test('a remind tag with a day is understood, and one with an unreadable time is reported, never dropped', () => {
  const { parseTag } = require('../src/main/brain/tags');
  assert.deepStrictEqual(parseTag('remind tomorrow 9am call the contractor'), { name: 'remind', when: 'tomorrow 9am', text: 'call the contractor' });
  assert.deepStrictEqual(parseTag('remind 9am tomorrow call'), { name: 'remind', when: '9am tomorrow', text: 'call' });
  assert.deepStrictEqual(parseTag('remind 10m tea'), { name: 'remind', when: '10m', text: 'tea' });
  assert.deepStrictEqual(parseTag('remind next friday dentist'), { name: 'remind', when: '', text: 'next friday dentist' }, 'kept, so COre can say it was not set');
});

test('timers are set on the PC without a brain, however they are asked', () => {
  const cases = {
    'set a timer for 90 seconds called pasta': { when: '90s', label: 'pasta' },
    'Set a timer for 5 minutes for tea.': { when: '5m', label: 'tea' },
    'start a 25 minute timer': { when: '25m', label: 'Timer' },
    'set a timer for 1 hour and 30 minutes': { when: '1h30m', label: 'Timer' },
    '5-minute timer for the eggs': { when: '5m', label: 'eggs' },
  };
  for (const [say, want] of Object.entries(cases)) assert.deepStrictEqual(quickIntent(say), { kind: 'timer', ...want }, say);
  for (const say of ['set a timer', 'set a timer for the meeting', 'what is a timer?']) assert.notStrictEqual((quickIntent(say) || {}).kind, 'timer', say);
});

test('a model imitating a [skill] result never shows the marker, and weather questions go to the weather service', () => {
  assert.strictEqual(stripTags('[skill] One moment... The weather is partly cloudy.'), 'One moment... The weather is partly cloudy.');
  const p = new TagStreamParser();
  const out = [...p.feed('[sk'), ...p.feed('ill] One moment.'), ...p.flush()];
  assert.strictEqual(out.filter((i) => i.type === 'text').map((i) => i.text).join(''), 'One moment.');
  assert.deepStrictEqual(quickIntent("what's the weather in Kuala Lumpur today?"), { kind: 'weather', city: 'kuala lumpur', day: 'today' });
  assert.deepStrictEqual(quickIntent('weather'), { kind: 'weather', city: '', day: 'today' });
  assert.strictEqual(quickIntent('is the weather nice for a picnic in the park this weekend'), null, 'open questions still go to the brain');
});

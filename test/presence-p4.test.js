'use strict';

// 13.0 P4: the interruption-cost model and the morning briefing (pure, deterministic).

const test = require('node:test');
const assert = require('node:assert');
const { decide, InterruptHistory } = require('../src/main/interrupt');
const B = require('../src/main/briefing');

const at = (state = {}, extra = {}) => ({ state: { hour: 10, idleSec: 30, typingSec: 60, ...state }, history: { now: 1e12, ...(extra.history || {}) }, ...extra.args });

test('urgent always gets through, but is never spoken at night, in a meeting, while typing, or to an empty room', () => {
  assert.deepStrictEqual(decide({ importance: 'urgent', ...at() }).channel, 'speak');
  for (const s of [{ hour: 23 }, { inMeeting: true }, { fullscreen: true }, { typingSec: 1 }]) {
    const d = decide({ importance: 'urgent', ...at(s) });
    assert.strictEqual(d.act, 'now'); assert.strictEqual(d.channel, 'chat', JSON.stringify(s));
  }
  assert.strictEqual(decide({ importance: 'urgent', ...at({ idleSec: 900, phonePaired: true }) }).channel, 'phone');
  assert.strictEqual(decide({ importance: 'urgent', ...at({ idleSec: 900 }) }).channel, 'chat');
});

test('ordinary moments wait for a good moment; quiet hours, meetings, typing, away, busy and hidden all defer them', () => {
  assert.strictEqual(decide({ importance: 'normal', ...at() }).act, 'now');
  for (const s of [{ hour: 23 }, { hour: 6 }, { inMeeting: true }, { fullscreen: true }, { typingSec: 2 }, { idleSec: 1200 }, { busy: true }, { hidden: true }]) {
    assert.strictEqual(decide({ importance: 'normal', ...at(s) }).act, 'later', JSON.stringify(s));
  }
  // High importance is shown silently in those moments, and goes to the phone when you are away.
  assert.deepStrictEqual(decide({ importance: 'high', ...at({ inMeeting: true }) }), { act: 'now', channel: 'chat', why: 'you are in a meeting or full screen: shown, not spoken' });
  assert.strictEqual(decide({ importance: 'high', ...at({ idleSec: 1200, phonePaired: true }) }).channel, 'phone');
  assert.strictEqual(decide({ importance: 'high', ...at({ hour: 2 }) }).channel, 'chat');
});

test('backoff: ignored kinds wait longer, then stop for the day; a daily limit; spacing per kind', () => {
  const now = 1e12;
  assert.strictEqual(decide({ kind: 'chat', importance: 'low', ...at({}, { history: { lastAt: { chat: now - 10 * 60000 } } }) }).act, 'later', 'small talk at most every 25 min');
  assert.strictEqual(decide({ kind: 'chat', importance: 'low', ...at({}, { history: { lastAt: { chat: now - 30 * 60000 } } }) }).act, 'now');
  assert.strictEqual(decide({ kind: 'chat', importance: 'low', ...at({}, { history: { lastAt: { chat: now - 30 * 60000 }, ignored: { chat: 1 } } }) }).act, 'later', 'one ignore doubles the gap');
  assert.strictEqual(decide({ kind: 'chat', importance: 'low', ...at({}, { history: { ignored: { chat: 3 } } }) }).act, 'drop');
  assert.strictEqual(decide({ kind: 'deadline', importance: 'high', ...at({}, { history: { ignored: { deadline: 3 } } }) }).act, 'now', 'high importance is not dropped for being ignored');
  assert.strictEqual(decide({ importance: 'normal', ...at({}, { history: { todayCount: 8 } }) }).act, 'drop');
  // The history records it all, per day.
  const mem = {}; let t = new Date(2026, 10, 14, 9).getTime();
  const h = new InterruptHistory({ store: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } }, now: () => t });
  h.delivered('briefing', 'normal'); h.ignoredOnce('chat'); h.ignoredOnce('chat');
  assert.deepStrictEqual([h.snapshot().todayCount, h.snapshot().ignored.chat], [1, 2]);
  h.answered('chat');
  assert.strictEqual(h.snapshot().ignored.chat, 0);
  t += 24 * 3600e3;
  assert.strictEqual(h.snapshot().todayCount, 0, 'a new day resets the count');
});

test('the morning briefing says only what it has a source for, once a day, when you are there', () => {
  const now = new Date(2026, 10, 14, 8, 30);
  const b = B.build({
    now,
    calendar: ['9:00 AM: Site meeting (Office)', '2:00 PM: Call with Ana'],
    tasks: [{ text: 'Send the drawings', due: '2026-11-14' }, { text: 'Pay invoice', due: '2026-11-10', overdue: true }, { text: 'Later thing', due: '2026-12-01' }],
    missions: [{ goal: 'tidy the report folder', status: 'done', at: now - 3600e3 }, { goal: 'rename the photos', status: 'ask', at: now - 7200e3 }, { goal: 'old', status: 'done', at: now - 3 * 86400e3 }],
  });
  assert.match(b.text, /\*\*Calendar\*\* \(your calendar feed\): 9:00 AM: Site meeting/);
  assert.match(b.text, /\*\*Due\*\* \(Cortex to-dos\): Send the drawings; Pay invoice \(overdue\)$/m);
  assert.ok(!/Later thing|old:/.test(b.text), 'not due yet / older than a day: left out');
  assert.match(b.text, /rename the photos: needs you/);
  assert.strictEqual(b.spoken, 'Good morning. Today you have 2 things on your calendar, 2 to-dos due, 1 mission waiting for you. The details are in the chat.');
  assert.strictEqual(B.build({ now, calendar: null, tasks: null, missions: [] }).empty, true, 'nothing known: no briefing');
  assert.strictEqual(B.due({ now, lastDay: '', idleSec: 5 }), '2026-11-14');
  assert.strictEqual(B.due({ now, lastDay: '2026-11-14', idleSec: 5 }), null, 'once a day');
  assert.strictEqual(B.due({ now, lastDay: '', idleSec: 600 }), null, 'only when you are at the PC');
  assert.strictEqual(B.due({ now: new Date(2026, 10, 14, 5), lastDay: '', idleSec: 5 }), null, 'not before the morning');
});

test('mission narration: milestones only (halfway, complete, needs you, stopped), never each step', () => {
  const { narrate } = require('../src/main/narration');
  const live = { subgoals: [{ status: 'done' }, { status: 'running' }, { status: 'pending' }, { status: 'pending' }] };
  assert.strictEqual(narrate({ type: 'verify', ok: true, index: 0 }, live), null, '1 of 4 is not a milestone');
  live.subgoals[1].status = 'done';
  assert.deepStrictEqual(narrate({ type: 'verify', ok: true, index: 1 }, live), { kind: 'mission-progress', importance: 'low', line: 'Halfway through the mission: 2 of 4 steps verified.' });
  assert.strictEqual(narrate({ type: 'verify', ok: true, index: 1 }, live), null, 'said once');
  assert.strictEqual(narrate({ type: 'verify', ok: false, index: 2 }, live), null, 'a failed try is retried silently');
  assert.strictEqual(narrate({ type: 'verify', ok: true }, { subgoals: [{ status: 'done' }, { status: 'pending' }] }), null, 'short missions only report the end');
  assert.strictEqual(narrate({ type: 'end', status: 'ask' }, live).importance, 'urgent');
  assert.match(narrate({ type: 'end', status: 'limit', reason: 'the step budget (60) is used up' }, live).line, /stopped: the step budget \(60\) is used up\. 2 of 4 steps were verified/);
  live.subgoals.forEach((x) => { x.status = 'done'; });
  assert.strictEqual(narrate({ type: 'end', status: 'done' }, live).line, 'Mission complete: all 4 steps verified.');
  assert.strictEqual(narrate({ type: 'subgoal', index: 3 }, live), null);
});

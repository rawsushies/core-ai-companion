'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { matchWake } = require('../src/main/handsfree');
require('../src/renderer/overlay/wake.js');
const { WakeListener } = globalThis;

test('wake phrase variants Whisper produces', () => {
  for (const t of ['Hey Core.', 'Hey, Kor!', 'okay cora', 'Hi Corey', 'hey core', ' Core. ', 'Yo, COre?']) {
    assert.deepStrictEqual(matchWake(t), { rest: '' }, t);
  }
});

test('a question right after the wake phrase is kept', () => {
  assert.deepStrictEqual(matchWake("Hey Core, what's the time?"), { rest: "what's the time?" });
  assert.deepStrictEqual(matchWake('OK Cora open my notes'), { rest: 'open my notes' });
});

test('ordinary speech does not wake COre', () => {
  for (const t of ['', 'The core of the problem is memory.', 'Hey Carl', 'I scored a goal', 'Hey you', 'coral reefs are pretty', 'Corey said hi']) {
    assert.strictEqual(matchWake(t), null, t);
  }
});

const quiet = () => new Float32Array(1600).fill(0.001);
const loud = () => Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 5) * 0.2);

function rig({ speaking = false, barge = true } = {}) {
  const got = { phrases: [], barge: 0 };
  const w = new WakeListener({
    canCheck: () => true,
    onPhrase: (a) => got.phrases.push(a.length),
    isSpeaking: () => speaking,
    bargeIn: () => barge,
    onBargeIn: () => got.barge++,
  });
  w.on = true;
  w._reset();
  return { w, got, feed: (fn, n) => { for (let i = 0; i < n; i++) w._chunk(fn()); } };
}

test('a short phrase after a pause is checked; long speech is not', () => {
  const a = rig();
  a.feed(quiet, 10); a.feed(loud, 8); a.feed(quiet, 6);
  assert.strictEqual(a.got.phrases.length, 1);
  assert.ok(a.got.phrases[0] >= 8 * 1600);
  const b = rig();
  b.feed(quiet, 10); b.feed(loud, 40); b.feed(quiet, 6);
  assert.strictEqual(b.got.phrases.length, 0, 'long speech ignored');
  const c = rig();
  c.feed(quiet, 10); c.feed(loud, 2); c.feed(quiet, 6);
  assert.strictEqual(c.got.phrases.length, 0, 'clicks and coughs ignored');
});

test('barge-in fires on sustained speech over COre, only when enabled', () => {
  const a = rig({ speaking: true });
  a.feed(quiet, 5); a.feed(loud, 6);
  assert.strictEqual(a.got.barge, 1);
  assert.strictEqual(a.got.phrases.length, 0);
  const b = rig({ speaking: true, barge: false });
  b.feed(quiet, 5); b.feed(loud, 10);
  assert.strictEqual(b.got.barge, 0);
});

test('paused while the normal listener has the mic', () => {
  const a = rig();
  a.w.pause(true);
  a.feed(quiet, 10); a.feed(loud, 8); a.feed(quiet, 6);
  assert.strictEqual(a.got.phrases.length, 0);
});

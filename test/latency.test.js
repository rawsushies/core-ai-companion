'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Latency, pct } = require('../src/main/latency');

test('a turn records each mark once, measured from the user\'s last word', () => {
  let t = 1000;
  const L = new Latency({ now: () => t });
  L.begin('voice', 400); // speech ended 600 ms before it reached COre
  t = 1000; L.mark('heard'); L.mark('react');
  t = 1150; L.mark('transcript');
  t = 1700; L.mark('firstToken');
  t = 1900; L.mark('firstAudio'); L.mark('firstAudio', 5000); // later sentences don't count
  t = 4000; const done = L.finish();
  assert.deepStrictEqual(done.marks, { heard: 600, react: 600, transcript: 750, firstToken: 1300, firstAudio: 1500, done: 3600 });
  const s = L.stats().voice;
  assert.strictEqual(s.n, 1);
  assert.deepStrictEqual(s.react, { p50: 600, p95: 600, n: 1, target: 300 });
  assert.match(Latency.format(L.stats()), /reacted 600\/600 ms \(target 300\)/);
});

test('percentiles, kinds kept apart, unknown marks ignored, history bounded', () => {
  assert.strictEqual(pct([5, 1, 3, 2, 4], 50), 3);
  assert.strictEqual(pct([5, 1, 3, 2, 4], 95), 5);
  assert.strictEqual(pct([], 50), null);
  let t = 0;
  const L = new Latency({ now: () => t, keep: 3 });
  for (let i = 0; i < 5; i++) { L.begin('typed', t); t += 100 + i; L.mark('firstToken'); L.mark('bogus'); L.finish(); }
  L.begin('typed', t); t += 50; L.reclassify('instant'); L.mark('firstToken'); L.finish();
  assert.strictEqual(L.history.length, 3);
  const s = L.stats();
  assert.strictEqual(s.typed.n, 2);
  assert.deepStrictEqual(s.instant.firstToken, { p50: 50, p95: 50, n: 1, target: 100 });
  assert.match(Latency.format(s), /instant \(1 turns.*first words \(brain\) 50\/50 ms ✓/);
});

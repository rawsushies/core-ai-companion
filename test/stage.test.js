const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/renderer/overlay/stage');

const view = { w: 1920, h: 1080 };
const r = 60;
const idle = { pos: { x: 1700, y: 800 }, target: { x: 1705, y: 803 }, tail: { x: 1700, y: 800 }, r };

test('idle window is small: about 1/12 of a 1080p screen or less', () => {
  const st = { bigSince: 0 };
  const rect = S.decide({ stage: { x: 0, y: 0, w: 1, h: 1 }, need: S.neededRect(idle), view, r, now: 0, settled: true, state: st });
  assert.ok(rect.w * rect.h <= (view.w * view.h) / 12, `${rect.w}x${rect.h}`);
  assert.ok(S.contains(rect, S.neededRect(idle)));
});

test('pointing across the screen grows the window to cover the hand and target in one step', () => {
  const st = { bigSince: 0 };
  const stage = S.decide({ stage: { x: 0, y: 0, w: 1, h: 1 }, need: S.neededRect(idle), view, r, now: 0, settled: true, state: st });
  const pointing = { ...idle, target: { x: 500, y: 300 }, point: { x: 300, y: 200 } };
  const need = S.neededRect(pointing);
  const next = S.decide({ stage, need, view, r, now: 10, settled: false, state: st });
  assert.ok(next, 'should grow');
  assert.ok(S.contains(next, S.clampTo(need, view)));
  assert.ok(next.x <= 300 - r * 0.9 && next.x + next.w >= 1700 + r * 2.1);
});

test('shrinks back only after being oversized and settled for a while', () => {
  const st = { bigSince: 0 };
  const big = { x: 0, y: 0, w: 1920, h: 1080 };
  const need = S.neededRect(idle);
  assert.equal(S.decide({ stage: big, need, view, r, now: 0, settled: false, state: st }), null, 'not while moving');
  assert.equal(S.decide({ stage: big, need, view, r, now: 100, settled: true, state: st }), null, 'not immediately');
  const fit = S.decide({ stage: big, need, view, r, now: 1700, settled: true, state: st });
  assert.ok(fit && fit.w < 600 && fit.h < 600);
});

test('rects are clamped to the screen', () => {
  const c = S.clampTo({ x: -100, y: 900, w: 500, h: 400 }, view);
  assert.deepEqual(c, { x: 0, y: 680, w: 500, h: 400 });
});

test('a caption widens the needed area', () => {
  const a = S.neededRect(idle);
  const b = S.neededRect({ ...idle, caption: { w: 440, h: 60, above: true } });
  assert.ok(b.w >= 440 && b.y < a.y);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ScreenWatch, isProblemTitle } = require('../src/main/watch');
const { refinePoint } = require('../src/main/pointing');

test('problem titles are recognised; look-alikes are not', () => {
  for (const t of ['Error', 'Microsoft Visual C++ Runtime Library - Fatal error', 'Chrome (Not Responding)', 'Unhandled exception', 'Installation failed']) assert.ok(isProblemTitle(t), t);
  for (const t of ['Visual Studio Code', 'fix error 0x8007 - Google Search', 'Inbox - Mail', 'Spotify', '']) assert.ok(!isProblemTitle(t), t);
});

test('watch offers once for a NEW problem window, rate limited', async () => {
  let titles = ['Editor', 'Old Error'];
  let t = 0;
  const offers = [];
  const w = new ScreenWatch({ listTitles: async () => titles, onProblem: (x) => offers.push(x), getConfig: () => ({}), isQuiet: () => true, now: () => t });
  await w.scan();
  assert.deepStrictEqual(offers, [], 'already-open windows are learned, not reported');
  titles = ['Editor', 'Old Error', 'Setup failed'];
  t = 100_000;
  await w.scan();
  assert.deepStrictEqual(offers, ['Setup failed']);
  titles = ['Editor', 'Old Error'];
  await w.scan();
  titles = ['Editor', 'Old Error', 'Setup failed'];
  t += 30_000;
  await w.scan();
  assert.strictEqual(offers.length, 1, 'same problem not repeated soon');
  titles = ['Editor', 'App (Not Responding)'];
  t += 20_000;
  await w.scan();
  assert.strictEqual(offers.length, 1, 'one offer a minute');
});

test('watch stays quiet when disabled or busy', async () => {
  let titles = ['A'];
  const offers = [];
  let quiet = false;
  const w = new ScreenWatch({ listTitles: async () => titles, onProblem: (x) => offers.push(x), getConfig: () => ({}), isQuiet: () => quiet, now: () => 1e9 });
  await w.scan();
  titles = ['A', 'Crash report'];
  await w.scan();
  assert.strictEqual(offers.length, 0);
});

function image(W, H, rect) {
  const data = new Uint8Array(W * H * 4).fill(240);
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 60;
  }
  return { data, width: W, height: H };
}

test('pointing snaps toward a nearby button', () => {
  const img = image(300, 200, { x: 120, y: 80, w: 40, h: 20 }); // centre 140,90
  const p = refinePoint(img, 112, 104);
  assert.ok(Math.hypot(p.x - 140, p.y - 90) < Math.hypot(112 - 140, 104 - 90), JSON.stringify(p));
});

test('pointing leaves blank areas and edges alone', () => {
  const blank = image(300, 200, { x: 0, y: 0, w: 0, h: 0 });
  assert.deepStrictEqual(refinePoint(blank, 150, 100), { x: 150, y: 100 });
  assert.deepStrictEqual(refinePoint(blank, -5, 10), { x: -5, y: 10 });
});

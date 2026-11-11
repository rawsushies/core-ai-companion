'use strict';

const test = require('node:test');
const assert = require('node:assert');
const G = require('../src/renderer/overlay/gestures');
const { parseTag } = require('../src/main/brain/tags');
const { persona } = require('../src/main/brain/persona');

test('at least 20 gestures, all sample to finite, bounded poses', () => {
  assert.ok(G.NAMES.length >= 20, `only ${G.NAMES.length}`);
  for (const n of G.NAMES) {
    const dur = G.duration(n);
    assert.ok(dur > 0.5 && dur < 5, n);
    for (let e = 0; e <= dur + 0.2; e += 0.1) {
      const s = G.sample(n, e, e, { n: 3 });
      assert.strictEqual(s.arms.length, 2, n);
      for (const a of s.arms) {
        if (!a) continue;
        for (const v of [a.x, a.y, a.ext, a.roll]) assert.ok(Number.isFinite(v), `${n} ${e}`);
        assert.ok(Math.hypot(a.x, a.y) < 3.2, `${n} reaches too far`);
        assert.strictEqual(a.fingers.length, 5, n);
        for (const f of a.fingers) assert.ok(f >= 0 && f <= 1, `${n} finger ${f}`);
        assert.ok(a.ext >= 0 && a.ext <= 1, n);
      }
      for (const v of Object.values(s.body)) assert.ok(Number.isFinite(v), n);
    }
    assert.ok(G.sample(n, dur + 0.01, 0).done, `${n} ends`);
    const end = G.sample(n, dur - 0.001, 0);
    for (const a of end.arms) if (a) assert.ok(a.ext < 0.05, `${n} retracts`);
  }
});

test('count shows the right number of fingers', () => {
  for (let n = 1; n <= 5; n++) {
    const s = G.sample('count', 2.7, 0, { n });
    assert.strictEqual(s.arms[1].fingers.reduce((a, b) => a + b, 0), n);
  }
});

test('names resolve with aliases and spacing', () => {
  assert.strictEqual(G.resolve('Thumbs Up'), 'thumbsup');
  assert.strictEqual(G.resolve('point-left'), 'pointleft');
  assert.strictEqual(G.resolve('hello'), 'wave');
  assert.strictEqual(G.resolve('dab'), null);
});

test('automatic gestures match the meaning of a sentence', () => {
  assert.strictEqual(G.autoGesture('Hello there, human.').name, 'wave');
  assert.strictEqual(G.autoGesture("Honestly, I don't know.").name, 'shrug');
  assert.strictEqual(G.autoGesture('Congratulations, it compiled.').name, 'celebrate');
  assert.deepStrictEqual(G.autoGesture('Second, save the file.'), { name: 'count', opts: { n: 2 } });
  assert.strictEqual(G.autoGesture('The file is in the downloads folder.'), null);
});

test('gesture tags parse; the persona lists every gesture without shell metacharacters', () => {
  assert.deepStrictEqual(parseTag('gesture shrug'), { name: 'gesture', gesture: 'shrug' });
  assert.deepStrictEqual(parseTag('gesture count 4'), { name: 'gesture', gesture: 'count', n: 4 });
  assert.strictEqual(parseTag('gesture explode'), null);
  assert.deepStrictEqual(parseTag('board Ship it; Freeze; Test; Tag; Publish; Extra'), { name: 'board', title: 'Ship it', points: ['Freeze', 'Test', 'Tag', 'Publish'] });
  assert.deepStrictEqual(parseTag('board Pipes | also | work').points, ['also', 'work']);
  assert.strictEqual(parseTag('board Only a title'), null, 'a board needs at least one point');
  const p = persona({ canReadFiles: false });
  for (const n of G.NAMES) assert.ok(p.includes(n), n);
  assert.ok(!/["&|<>^%!]/.test(p));
});

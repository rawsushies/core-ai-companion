'use strict';

const test = require('node:test');
const assert = require('node:assert');
const SH = require('../src/renderer/overlay/shapes');
const { parseTag } = require('../src/main/brain/tags');
const { persona } = require('../src/main/brain/persona');

test('shape names, aliases and text shapes resolve', () => {
  assert.ok(SH.NAMES.length >= 20);
  assert.strictEqual(SH.resolve('laughing'), 'laugh');
  assert.strictEqual(SH.resolve('Heart'), 'heart');
  assert.strictEqual(SH.resolve('42'), 'text:42');
  assert.strictEqual(SH.resolve('ok'), 'text:OK');
  assert.strictEqual(SH.resolve('x'), 'cross');
  assert.strictEqual(SH.resolve('banana'), null);
  assert.strictEqual(SH.resolve('ABCD'), null);
});

test('expressive shapes have a sound', () => {
  assert.strictEqual(SH.exprFor('laugh'), 'giggle');
  assert.strictEqual(SH.exprFor('sad'), 'sigh');
  assert.strictEqual(SH.exprFor('up'), null);
});

test('form tags parse and the persona documents every shape', () => {
  assert.deepStrictEqual(parseTag('form laugh'), { name: 'form', shape: 'laugh' });
  assert.deepStrictEqual(parseTag('form 7'), { name: 'form', shape: 'text:7' });
  assert.strictEqual(parseTag('form something weird'), null);
  const p = persona({});
  for (const n of SH.NAMES) assert.ok(p.includes(n), n);
});

test('points samples the drawn pixels into -1..1', () => {
  // A minimal fake canvas whose only lit pixel is the centre.
  const fake = (w, h) => ({
    getContext: () => new Proxy({
      getImageData: () => {
        const d = new Uint8ClampedArray(w * h * 4);
        d[(64 * w + 64) * 4 + 3] = 255;
        return { data: d };
      },
    }, { get: (t, k) => (k in t ? t[k] : () => {}), set: () => true }),
  });
  const pts = SH.points('ring', fake);
  assert.strictEqual(pts.length, SH.POINTS * 2);
  for (const v of pts) assert.ok(v >= -0.01 && v <= 0.03, String(v));
});

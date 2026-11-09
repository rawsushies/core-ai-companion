'use strict';

const test = require('node:test');
const assert = require('node:assert');
const CL = require('../src/main/clones');
const { parseTag } = require('../src/main/brain/tags');
const G = require('../src/renderer/overlay/gestures');

const area = { x: 0, y: 0, width: 1600, height: 900 };

test('helpers are placed near COre without overlapping anything', () => {
  const core = CL.orbRect(1400, 700, 60);
  const dock = { x: 1230, y: 790, w: 340, h: 100 };
  const avoid = [core, dock];
  const placed = [];
  for (let i = 0; i < 3; i++) {
    const p = CL.placeClone({ area, avoid, size: 240, near: { x: 1400, y: 700 } });
    assert.ok(p, `helper ${i} placed`);
    const r = { x: p.x - 120, y: p.y - 120, w: 240, h: 240 };
    for (const a of avoid) assert.ok(!CL.overlaps(r, a), `helper ${i} overlaps`);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1600 && r.y + r.h <= 900);
    placed.push(p);
    avoid.push(r);
  }
  // Each stays reasonably close to COre.
  for (const p of placed) assert.ok(Math.hypot(p.x - 1400, p.y - 700) < 700);
});

test('placement gives up when there is no room', () => {
  assert.strictEqual(CL.placeClone({ area: { x: 0, y: 0, width: 200, height: 200 }, avoid: [{ x: 0, y: 0, w: 200, h: 200 }], size: 100, near: { x: 0, y: 0 } }), null);
});

test('task prompt is shell-safe and asks for a spoken first sentence', () => {
  const p = CL.cloneTaskPrompt('Compare "A" & B | C', 'Helper Cyan');
  assert.ok(p.startsWith('[helper]'));
  assert.ok(!/["&|<>^%!]/.test(p));
  assert.ok(p.includes('Helper Cyan'));
});

test('spoken summary is the first paragraph, clean and short', () => {
  assert.strictEqual(CL.spokenSummary('**Done**: three ideas. [[mood happy]]\n\n## Details\n- a'), 'Done: three ideas.');
  const long = `${'Word '.repeat(30)}end. ${'more '.repeat(40)}`;
  assert.ok(CL.spokenSummary(long).length <= 221);
});

test('the speech floor lets one voice at a time, COre first', () => {
  let mainBusy = true;
  const order = [];
  const f = new CL.SpeechFloor({ mainBusy: () => mainBusy });
  f.request('a', () => order.push('a'));
  f.request('b', () => order.push('b'));
  f.request('a', () => order.push('dup'));
  assert.deepStrictEqual(order, []);
  mainBusy = false;
  f.pump();
  assert.deepStrictEqual(order, ['a']);
  f.pump();
  assert.deepStrictEqual(order, ['a'], 'b waits for a');
  f.release('a');
  assert.deepStrictEqual(order, ['a', 'b']);
  f.release('b');
  assert.strictEqual(f.holder, null);
});

test('clone tags parse, looks are distinct, split/merge are internal gestures', () => {
  assert.deepStrictEqual(parseTag('clone draft the email to Sam'), { name: 'clone', task: 'draft the email to Sam' });
  assert.strictEqual(parseTag('clone'), null);
  assert.strictEqual(new Set(CL.LOOKS.map((l) => l.voice)).size, CL.LOOKS.length);
  assert.ok(G.LIB.split && G.LIB.merge);
  assert.ok(!G.NAMES.includes('split'));
  assert.strictEqual(G.resolve('split'), 'split');
});

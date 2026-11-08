const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/renderer/overlay/motion');

test('body springs to its target and the tail follows', () => {
  const b = M.createBody({ x: 0, y: 0, r: 40 });
  b.target = { x: 300, y: 100 };
  for (let i = 0; i < 300; i++) M.step(b, 1 / 60);
  assert.ok(Math.hypot(b.pos.x - 300, b.pos.y - 100) < 1);
  assert.ok(Math.hypot(b.tail.x - 300, b.tail.y - 100) < 2);
});

test('motion overshoots a little (liquid wobble) but stays stable on long frames', () => {
  const b = M.createBody({ x: 0, y: 0, r: 40 });
  b.target = { x: 100, y: 0 };
  let max = 0;
  for (let i = 0; i < 120; i++) { M.step(b, 1 / 60); max = Math.max(max, b.pos.x); }
  assert.ok(max > 100.5, 'expected some overshoot');
  for (let i = 0; i < 20; i++) M.step(b, 0.25);
  assert.ok(Number.isFinite(b.pos.x) && Math.abs(b.pos.x - 100) < 1);
});

test('parking spot stays on screen and keeps a reach distance', () => {
  const W = 1920, H = 1080, r = 46;
  for (const pt of [{ x: 5, y: 5 }, { x: 1915, y: 1075 }, { x: 960, y: 540 }, { x: 100, y: 900 }]) {
    const p = M.parkFor(pt, r, W, H);
    assert.ok(p.x >= r && p.x <= W - r && p.y >= r && p.y <= H - r);
  }
  const p = M.parkFor({ x: 200, y: 200 }, r, W, H);
  assert.ok(Math.hypot(p.x - 200, p.y - 200) > r * 3);
});

test('a fully extended pointing arm ends exactly at its target', () => {
  const b = M.createBody({ x: 500, y: 500, r: 40 });
  const arm = b.arms[0];
  arm.mode = 'point';
  arm.target = { x: 300, y: 380 };
  arm.extend = 1;
  const g = M.armGeometry(b, arm, 0);
  assert.equal(g.pts.length, 4);
  assert.ok(Math.hypot(g.pts[3].x - 300, g.pts[3].y - 380) < 1e-6);
  assert.ok(g.radii[0] > g.radii[3], 'arm tapers to a fingertip');
});

test('retracted arm switches off', () => {
  const b = M.createBody({ x: 0, y: 0, r: 40 });
  b.arms[1].mode = 'explain';
  b.arms[1].goal = 0;
  b.arms[1].extend = 0.5;
  for (let i = 0; i < 200; i++) M.step(b, 1 / 60);
  assert.equal(b.arms[1].mode, 'off');
});

test('fast moves stretch the tail but never pinch it off into a droplet', () => {
  const b = M.createBody({ x: 0, y: 0, r: 40 });
  b.target = { x: 1500, y: 0 };
  let maxGap = 0;
  for (let i = 0; i < 240; i++) {
    M.step(b, 1 / 60);
    maxGap = Math.max(maxGap, Math.hypot(b.tail.x - b.pos.x, b.tail.y - b.pos.y));
  }
  assert.ok(maxGap > 20, 'tail should visibly lag');
  assert.ok(maxGap <= 40 * 1.25 + 1e-6, `tail lag ${maxGap} exceeded the cap`);
});

// COre motion: spring physics for the liquid body, its trailing "tail" blob,
// and the two liquid arms. All coordinates are CSS pixels, y pointing down.
// UMD so the same file runs in the overlay and in node --test.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Motion = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const len = (x, y) => Math.hypot(x, y);

  // Damped spring, semi-implicit Euler. zeta < 1 overshoots (liquid wobble).
  function spring1(x, v, target, k, zeta, dt) {
    const c = 2 * zeta * Math.sqrt(k);
    v += (k * (target - x) - c * v) * dt;
    x += v * dt;
    return [x, v];
  }

  function spring2(p, v, target, k, zeta, dt) {
    const [x, vx] = spring1(p.x, v.x, target.x, k, zeta, dt);
    const [y, vy] = spring1(p.y, v.y, target.y, k, zeta, dt);
    p.x = x; p.y = y; v.x = vx; v.y = vy;
  }

  function makeArm(side) {
    return {
      side, // -1 left, +1 right
      mode: 'off', // 'off' | 'point' | 'explain'
      goal: 0,
      extend: 0,
      extendVel: 0,
      target: { x: 0, y: 0 },
      phase: side > 0 ? 1.7 : 0.3,
    };
  }

  function createBody({ x, y, r }) {
    return {
      r,
      pos: { x, y },
      vel: { x: 0, y: 0 },
      tail: { x, y },
      tailVel: { x: 0, y: 0 },
      target: { x, y },
      dragging: false,
      arms: [makeArm(-1), makeArm(1)],
    };
  }

  function step(body, dtTotal) {
    // Substep so the springs stay stable on slow frames.
    const n = Math.max(1, Math.ceil(dtTotal / (1 / 120)));
    const dt = Math.min(dtTotal, 0.1) / n;
    for (let i = 0; i < n; i++) {
      if (body.dragging) spring2(body.pos, body.vel, body.target, 900, 0.9, dt);
      else spring2(body.pos, body.vel, body.target, 46, 0.52, dt);
      // The tail lags behind the body; smooth-unioned in the shader this
      // reads as liquid being dragged along.
      spring2(body.tail, body.tailVel, body.pos, 20, 0.78, dt);
      // Never let the tail lag so far that it pinches off into a separate
      // droplet: keep it within reach so it stays a melted teardrop.
      const lx = body.tail.x - body.pos.x;
      const ly = body.tail.y - body.pos.y;
      const lag = Math.hypot(lx, ly);
      const maxLag = body.r * 1.25;
      if (lag > maxLag) {
        body.tail.x = body.pos.x + (lx / lag) * maxLag;
        body.tail.y = body.pos.y + (ly / lag) * maxLag;
        body.tailVel.x = body.vel.x;
        body.tailVel.y = body.vel.y;
      }
      for (const arm of body.arms) {
        const [e, ev] = spring1(arm.extend, arm.extendVel, arm.goal, 58, 0.5, dt);
        arm.extend = clamp(e, 0, 1.2);
        arm.extendVel = ev;
        if (arm.goal === 0 && arm.extend < 0.01) arm.mode = 'off';
      }
    }
  }

  // Where the body should sit so a hand can comfortably reach `pt`:
  // a few radii away from it, on the side facing the screen centre.
  function parkFor(pt, r, w, h) {
    let dx = w / 2 - pt.x;
    let dy = h / 2 - pt.y;
    let d = len(dx, dy);
    if (d < 1) { dx = 1; dy = 0.3; d = len(dx, dy); }
    const reach = r * 3.6;
    const m = r * 1.6;
    return {
      x: clamp(pt.x + (dx / d) * reach, m, w - m),
      y: clamp(pt.y + (dy / d) * reach, m, h - m),
    };
  }

  function smoothstep(a, b, x) {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  // Four control points + four radii describing one tapered liquid arm.
  function armGeometry(body, arm, t) {
    const r = body.r;
    const p = body.pos;
    let tx, ty;
    if (arm.mode === 'explain') {
      tx = p.x + arm.side * (r * 2.1 + Math.sin(t * 2.3 + arm.phase) * r * 0.28);
      ty = p.y + r * 0.25 + Math.sin(t * 3.1 + arm.phase) * r * 0.32;
    } else {
      tx = arm.target.x;
      ty = arm.target.y;
    }
    let dx = tx - p.x;
    let dy = ty - p.y;
    const dist = Math.max(1, len(dx, dy));
    dx /= dist; dy /= dist;
    const px = -dy;
    const py = dx;

    const e = clamp(arm.extend, 0, 1.2);
    const base = { x: p.x + dx * r * 0.55, y: p.y + dy * r * 0.55 };
    const tip = { x: lerp(base.x, tx, e), y: lerp(base.y, ty, e) };

    // Liquid wobble across the arm plus a little gravity sag.
    const wob = (s, f) => Math.sin(t * f + arm.phase + s * 3) * r * 0.2 * (1 - 0.55 * Math.min(e, 1));
    const sag = (s) => Math.sin(Math.PI * s) * r * 0.22 * (1 - 0.5 * Math.min(e, 1));
    const at = (s) => ({
      x: lerp(base.x, tip.x, s) + px * wob(s, 4.1),
      y: lerp(base.y, tip.y, s) + py * wob(s, 4.1) + sag(s),
    });

    const reach = len(tip.x - base.x, tip.y - base.y);
    const thin = clamp((r * 4.5) / Math.max(reach, 1), 0.5, 1); // long reaches get thinner
    const grow = smoothstep(0, 0.3, e);
    const radii = arm.mode === 'point'
      ? [r * 0.32, r * 0.2 * thin, r * 0.14 * thin, r * 0.085] // tapers to a fingertip
      : [r * 0.3, r * 0.17 * thin, r * 0.13 * thin, r * 0.19]; // open palm
    return {
      on: e,
      pts: [base, at(0.36), at(0.72), tip],
      radii: radii.map((v) => v * grow),
    };
  }

  function wander(home, t) {
    return {
      x: home.x + Math.sin(t * 0.23) * 16 + Math.sin(t * 0.61 + 2) * 5,
      y: home.y + Math.sin(t * 0.37 + 1.3) * 10,
    };
  }

  function defaultHome(w, h, r) {
    return { x: w - r * 3, y: h - r * 4 };
  }

  return { createBody, step, parkFor, armGeometry, wander, defaultHome, spring1, clamp };
});

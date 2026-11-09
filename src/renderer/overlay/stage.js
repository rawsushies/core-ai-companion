// The overlay "stage": the small screen rectangle COre's transparent window
// occupies. A full-screen transparent window forces Windows to recomposite
// the whole desktop every frame (system-wide lag), so the window only covers
// what COre needs right now and grows/shrinks as it moves, points or talks.
// All rects are in display coordinates: { x, y, w, h }.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Stage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function grow(box, x, y, m) {
    box.x0 = Math.min(box.x0, x - m);
    box.y0 = Math.min(box.y0, y - m);
    box.x1 = Math.max(box.x1, x + m);
    box.y1 = Math.max(box.y1, y + m);
  }

  // Everything that must be visible: the body with its glow and smoke puffs,
  // the tail, where the body is heading, both arms with their hands, a point
  // target, and the caption.
  function neededRect({ pos, target, tail, r, arms = [], point = null, caption = null, extra = [] }) {
    const body = r * 2.1;
    const box = { x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y };
    grow(box, pos.x, pos.y, body);
    if (target) grow(box, target.x, target.y, body);
    if (tail) grow(box, tail.x, tail.y, r * 1.2);
    for (const a of arms) {
      if (!a) continue;
      for (const p of a.pts) grow(box, p.x, p.y, r * 0.9);
    }
    if (point) grow(box, point.x, point.y, r * 0.9);
    if (caption) {
      box.x0 = Math.min(box.x0, pos.x - caption.w / 2 - 12);
      box.x1 = Math.max(box.x1, pos.x + caption.w / 2 + 12);
      const cy = caption.above ? pos.y - r * 1.55 - caption.h - 12 : pos.y + r * 1.55 + caption.h + 12;
      box.y0 = Math.min(box.y0, cy);
      box.y1 = Math.max(box.y1, cy);
    }
    for (const e of extra) {
      if (!e) continue;
      grow(box, e.x, e.y, 8);
      grow(box, e.x + e.w, e.y + e.h, 8);
    }
    return { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 };
  }

  function pad(rect, m) {
    return { x: rect.x - m, y: rect.y - m, w: rect.w + 2 * m, h: rect.h + 2 * m };
  }

  function contains(outer, inner, tol = 2) {
    return inner.x >= outer.x - tol && inner.y >= outer.y - tol
      && inner.x + inner.w <= outer.x + outer.w + tol
      && inner.y + inner.h <= outer.y + outer.h + tol;
  }

  function clampTo(rect, view) {
    const w = Math.min(Math.round(rect.w), view.w);
    const h = Math.min(Math.round(rect.h), view.h);
    const x = Math.min(Math.max(Math.round(rect.x), 0), view.w - w);
    const y = Math.min(Math.max(Math.round(rect.y), 0), view.h - h);
    return { x, y, w, h };
  }

  function sameSize(a, b) {
    return Math.abs(a.w - b.w) < 2 && Math.abs(a.h - b.h) < 2;
  }

  // Flicker-free policy. Resizing a transparent window rebuilds its canvas
  // (a visible flash), moving it doesn't. So COre normally lives in a fixed
  // square that only moves; it resizes only when a gesture starts or ends:
  //   dragging -> one resize to the whole screen for the whole drag
  //   need bigger than the square (pointing far) -> one resize to fit
  //   settled again -> one resize back to the square
  // state carries { bigSince } between calls.
  function decideSteady({ stage, need, view, r, now, settled, dragging, state }) {
    if (dragging) {
      const full = { x: 0, y: 0, w: view.w, h: view.h };
      return sameSize(stage, full) && stage.x === 0 && stage.y === 0 ? null : full;
    }
    const side = Math.max(Math.round(r * 7.4), 440);
    const fitsSquare = need.w <= side - 8 && need.h <= side - 8;
    const square = () => clampTo({ x: need.x + need.w / 2 - side / 2, y: need.y + need.h / 2 - side / 2, w: side, h: side }, view);
    if (!fitsSquare) {
      state.bigSince = 0;
      return contains(stage, need) ? null : clampTo(pad(need, r * 1.2), view);
    }
    if (sameSize(stage, { w: side, h: side })) {
      state.bigSince = 0;
      return contains(stage, need, -4) ? null : square(); // move only
    }
    // Bigger (after a drag/point) or smaller: go back to the square once settled.
    if (!contains(stage, need)) { state.bigSince = 0; return square(); }
    if (!settled) { state.bigSince = 0; return null; }
    if (!state.bigSince) state.bigSince = now;
    if (now - state.bigSince > 900) { state.bigSince = 0; return square(); }
    return null;
  }

  // Older adaptive policy (kept for tests/tools).
  function decide({ stage, need, view, r, now, settled, state, margin: m }) {
    const margin = m || r * 1.2;
    if (!contains(stage, need)) {
      state.bigSince = 0;
      return clampTo(pad(need, margin), view);
    }
    const fit = clampTo(pad(need, margin), view);
    const tooBig = stage.w * stage.h > 2.2 * fit.w * fit.h;
    if (tooBig && settled) {
      if (!state.bigSince) state.bigSince = now;
      if (now - state.bigSince > 1500) {
        state.bigSince = 0;
        return fit;
      }
    } else {
      state.bigSince = 0;
    }
    return null;
  }

  return { neededRect, pad, contains, clampTo, decide, decideSteady };
});

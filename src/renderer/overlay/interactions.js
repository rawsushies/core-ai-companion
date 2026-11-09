// Recognises playful touches from cursor movement over COre (no button held):
//   pet:    slow back-and-forth strokes across the smoke
//   tickle: fast, small, jittery wiggles
// feed(x, y, tMs) returns 'pet' | 'tickle' | null. A cooldown keeps one
// stroke session from firing over and over.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Interactions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class TouchDetector {
    constructor({ r = 60, cooldown = 2500 } = {}) {
      this.r = r;
      this.cooldown = cooldown;
      this.pts = [];
      this.lastFire = -Infinity;
    }

    reset() { this.pts = []; }

    feed(x, y, t) {
      this.pts.push({ x, y, t });
      while (this.pts.length && t - this.pts[0].t > 2000) this.pts.shift();
      if (t - this.lastFire < this.cooldown || this.pts.length < 6) return null;
      let path = 0;
      let flips = 0;
      let lastSign = 0;
      let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
      for (let i = 1; i < this.pts.length; i++) {
        const a = this.pts[i - 1];
        const b = this.pts[i];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        path += Math.hypot(dx, dy);
        // Direction changes along the dominant stroke axis.
        const d = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
        if (Math.abs(d) > 1.5) {
          const s = Math.sign(d);
          if (lastSign && s !== lastSign) flips++;
          lastSign = s;
        }
        minX = Math.min(minX, b.x); maxX = Math.max(maxX, b.x);
        minY = Math.min(minY, b.y); maxY = Math.max(maxY, b.y);
      }
      const span = (this.pts[this.pts.length - 1].t - this.pts[0].t) / 1000;
      if (span < 0.3) return null;
      const rate = flips / span;
      const speed = path / span; // px/s
      const extent = Math.max(maxX - minX, maxY - minY);
      const r = this.r;
      let kind = null;
      if (flips >= 6 && extent < r * 1.1 && rate >= 6) kind = 'tickle';
      else if (flips >= 3 && span >= 0.6 && rate < 6 && extent > r * 0.6 && speed > r * 1.5 && speed < r * 40) kind = 'pet';
      if (kind) {
        this.lastFire = t;
        this.pts = [];
      }
      return kind;
    }
  }

  // How fast the pointer was going when a drag ended (px/s), from the last
  // ~120 ms of samples [{x, y, t}].
  function releaseVelocity(samples) {
    if (!samples || samples.length < 2) return { x: 0, y: 0 };
    const last = samples[samples.length - 1];
    let first = samples[0];
    for (let i = samples.length - 1; i >= 0; i--) {
      if (last.t - samples[i].t > 120) break;
      first = samples[i];
    }
    const dt = Math.max(1, last.t - first.t) / 1000;
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  }

  return { TouchDetector, releaseVelocity };
});

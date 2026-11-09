'use strict';

// COre's orb for phones: a 2D canvas of glowing particles flowing around a
// sphere. Built for low and mid-range phones:
//  - particle count, frame rate and resolution come from the device class
//    (low: 180 particles, 24 fps, 1x; mid: 320, 30 fps, 1.5x; high: 520, 30 fps, 2x)
//  - nothing is drawn while the app is hidden or the orb is off screen
//  - reduced motion: one still frame
(function (root) {
  function deviceTier(nav = navigator) {
    const cores = nav.hardwareConcurrency || 4;
    const mem = nav.deviceMemory || 4;
    if (cores <= 4 || mem <= 3) return 'low';
    if (cores <= 6 || mem <= 4) return 'mid';
    return 'high';
  }

  const TIERS = {
    low: { particles: 180, fps: 24, dpr: 1 },
    mid: { particles: 320, fps: 30, dpr: 1.5 },
    high: { particles: 520, fps: 30, dpr: 2 },
  };

  class PhoneOrb {
    constructor(canvas, { tier = deviceTier(), color = [61, 255, 133] } = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: true });
      this.setTier(tier);
      this.color = color;
      this.mode = 'idle'; // idle | thinking | speaking | offline
      this.frames = 0;
      this.raf = 0;
      this.last = 0;
      this.visible = true;
      this.still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.start()));
      if ('IntersectionObserver' in window) {
        new IntersectionObserver((e) => { this.visible = e[0].isIntersecting; if (this.visible) this.start(); else this.stop(); }).observe(canvas);
      }
    }

    setTier(tier) {
      this.tier = TIERS[tier] ? tier : 'mid';
      const t = TIERS[this.tier];
      this.fps = t.fps;
      this.dprMax = t.dpr;
      this.p = Array.from({ length: t.particles }, () => ({
        th: Math.random() * Math.PI * 2, ph: Math.acos(2 * Math.random() - 1),
        sp: 0.15 + Math.random() * 0.35, r: 0.82 + Math.random() * 0.22, s: 0.6 + Math.random() * 1.4,
      }));
      this.resize();
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, this.dprMax);
      const w = this.canvas.clientWidth || 160;
      const h = this.canvas.clientHeight || 160;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.scale = dpr;
    }

    start() {
      if (this.raf || document.hidden || !this.visible) return;
      if (this.still) { this.draw(0); return; }
      const loop = (now) => {
        this.raf = requestAnimationFrame(loop);
        if (now - this.last < 1000 / this.fps - 1) return;
        const dt = Math.min(0.1, (now - (this.last || now)) / 1000);
        this.last = now;
        this.draw(dt);
      };
      this.raf = requestAnimationFrame(loop);
    }

    stop() { cancelAnimationFrame(this.raf); this.raf = 0; this.last = 0; }

    draw(dt) {
      this.frames++;
      const { ctx, canvas } = this;
      const W = canvas.width;
      const H = canvas.height;
      const R = Math.min(W, H) * 0.32;
      const cx = W / 2;
      const cy = H / 2;
      const t = performance.now() / 1000;
      const energy = this.mode === 'speaking' ? 1.6 : this.mode === 'thinking' ? 1.3 : this.mode === 'offline' ? 0.4 : 1;
      const [r, g, b] = this.mode === 'offline' ? [134, 165, 149] : this.color;
      ctx.clearRect(0, 0, W, H);
      const glow = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.5);
      glow.addColorStop(0, `rgba(${r},${g},${b},${0.16 * energy})`);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      const pulse = this.mode === 'speaking' ? 1 + 0.05 * Math.sin(t * 9) : 1 + 0.02 * Math.sin(t * 1.4);
      for (const q of this.p) {
        q.th += q.sp * dt * energy;
        const wob = 0.06 * Math.sin(t * 0.7 + q.ph * 3);
        const rr = R * q.r * pulse * (1 + wob);
        const x = Math.sin(q.ph) * Math.cos(q.th);
        const z = Math.sin(q.ph) * Math.sin(q.th);
        const y = Math.cos(q.ph + 0.25 * Math.sin(t * 0.3));
        const depth = (z + 1.4) / 2.4; // back particles dimmer
        ctx.fillStyle = `rgba(${r},${g},${b},${(0.25 + 0.6 * depth) * Math.min(1, energy)})`;
        const size = q.s * this.scale * (0.6 + depth);
        ctx.fillRect(cx + x * rr - size / 2, cy + y * rr - size / 2, size, size);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  root.PhoneOrb = PhoneOrb;
  root.deviceTier = deviceTier;
  root.ORB_TIERS = TIERS;
})(window);

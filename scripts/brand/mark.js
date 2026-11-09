'use strict';

// COre's logo mark, generated: a sphere of glowing smoke filaments around a
// dark core. Deterministic (seeded), so `node scripts/brand/build.js` always
// produces the same logo.

const TAU = Math.PI * 2;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const rot = (v, ax, ay) => {
  let [x, y, z] = v;
  [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
  [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
  return [x, y, z];
};

// Filament paths: tilted rings on a sphere, gently perturbed like smoke,
// projected to 2D. Back-facing parts are dropped (the core hides them).
function strands({ count = 70, seed = 11, size = 512 }) {
  const rand = rng(seed);
  const c = size / 2;
  const R = size * 0.36;
  const out = [];
  for (let i = 0; i < count; i++) {
    // Avoid rings seen edge-on (they project to straight lines): keep the
    // ring's normal at least a little toward the viewer.
    let ax; let ay;
    do { ax = rand() * TAU; ay = rand() * TAU; } while (Math.abs(rot([0, 0, 1], ax, ay)[2]) < 0.38);
    const wob = 0.02 + rand() * 0.05;
    const wob2 = rand() * 0.03;
    const freq = 2 + Math.floor(rand() * 4);
    const ph = rand() * TAU;
    const shell = 0.9 + rand() * 0.16;
    const arc0 = rand() * TAU;
    const arcLen = TAU * (0.25 + rand() * 0.45); // strands are partial arcs
    const pts = [];
    for (let k = 0; k <= 64; k++) {
      const t = arc0 + (arcLen * k) / 64;
      const r = shell * (1 + wob * Math.sin(freq * t + ph) + wob2 * Math.sin(freq * 2.7 * t + ph * 1.3));
      const p = rot([Math.cos(t) * r, Math.sin(t) * r, 0], ax, ay);
      pts.push(p);
    }
    // Split into front-facing runs.
    let run = [];
    const flush = () => {
      if (run.length > 4) {
        const depth = run.reduce((a, p) => a + p[2], 0) / run.length; // 0..1 front
        out.push({
          d: run.map((p, j) => `${j ? 'L' : 'M'}${(c + p[0] * R).toFixed(1)} ${(c + p[1] * R).toFixed(1)}`).join(''),
          o: (0.15 + 0.85 * Math.min(1, depth * 1.4) * (0.4 + 0.6 * rand())).toFixed(2),
          w: (size / 512) * (0.6 + rand() * 1.4),
        });
      }
      run = [];
    };
    for (const p of pts) { if (p[2] > -0.05) run.push(p); else flush(); }
    flush();
  }
  return out;
}

// Fine smoke dust on the shell, denser near the rim (limb brightening).
function dust({ count = 420, seed = 5, size = 512 }) {
  const rand = rng(seed);
  const c = size / 2;
  const R = size * 0.36;
  let out = '';
  for (let i = 0; i < count; i++) {
    const a = rand() * TAU;
    const rr = Math.pow(rand(), 0.35) * (0.86 + rand() * 0.2); // biased outward
    const x = c + Math.cos(a) * rr * R;
    const y = c + Math.sin(a) * rr * R;
    out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${((size / 512) * (0.5 + rand() * 1.1)).toFixed(2)}" fill-opacity="${(0.2 + rand() * 0.6).toFixed(2)}"/>`;
  }
  return out;
}

function markSvg({ size = 512, bg = false, count = 70 } = {}) {
  const c = size / 2;
  const R = size * 0.36;
  const s = strands({ count, size });
  const paths = s.map((p) => `<path d="${p.d}" stroke-opacity="${p.o}" stroke-width="${p.w.toFixed(2)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <radialGradient id="halo" cx="50%" cy="50%" r="50%">
      <stop offset="0.62" stop-color="#3DFF85" stop-opacity="0.30"/>
      <stop offset="0.82" stop-color="#3DFF85" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#3DFF85" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="core" cx="46%" cy="42%" r="55%">
      <stop offset="0" stop-color="#0B1F15"/>
      <stop offset="0.7" stop-color="#05110B"/>
      <stop offset="1" stop-color="#020604"/>
    </radialGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="${(size / 512) * 5}" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  ${bg ? `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="#05070A"/>` : ''}
  <circle cx="${c}" cy="${c}" r="${size * 0.49}" fill="url(#halo)"/>
  <circle cx="${c}" cy="${c}" r="${R * 0.94}" fill="url(#core)"/>
  <g fill="#9DFFC6" filter="url(#glow)">${dust({ size })}</g>
  <g fill="none" stroke="#7DFFB0" stroke-linecap="round" filter="url(#glow)">${paths}</g>
  <circle cx="${c}" cy="${c}" r="${R * 0.98}" fill="none" stroke="#3DFF85" stroke-opacity="0.55" stroke-width="${(size / 512) * 3}" filter="url(#glow)"/>
  <circle cx="${c - R * 0.34}" cy="${c - R * 0.38}" r="${R * 0.045}" fill="#D9FFE9" fill-opacity="0.8" filter="url(#glow)"/>
</svg>`;
}

// Small sizes (16-48 px): filaments turn to mush, so a bold simplified ring.
function glyphSvg({ size = 32, bg = false } = {}) {
  const c = size / 2;
  const R = size * 0.34;
  const w = Math.max(1.6, size * 0.11);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="0.5" stop-color="#3DFF85" stop-opacity="0.45"/><stop offset="1" stop-color="#3DFF85" stop-opacity="0"/></radialGradient></defs>
  ${bg ? `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="#05070A"/>` : ''}
  <circle cx="${c}" cy="${c}" r="${size * 0.49}" fill="url(#g)"/>
  <circle cx="${c}" cy="${c}" r="${R}" fill="#04100A" stroke="#3DFF85" stroke-width="${w}"/>
  <path d="M${c - R * 0.55} ${c + R * 0.1} Q${c} ${c - R * 0.6} ${c + R * 0.55} ${c - R * 0.05}" fill="none" stroke="#9DFFC6" stroke-width="${w * 0.55}" stroke-linecap="round"/>
</svg>`;
}

module.exports = { markSvg, glyphSvg };

// Shapes COre can form out of its smoke: emoji faces, symbols, digits and
// letters. Each shape is drawn once on a tiny 2D canvas and sampled into a
// fixed number of target points (x, y in -1..1); the particle shader pulls
// smoke toward them. So a shape costs one small texture upload, nothing per frame.
// UMD: names, parsing and the voice expression table are also used in main
// and in node --test (drawing needs a canvas and only runs in the overlay).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shapes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 128;
  const POINTS = 2048; // = shape texture 64 x 32
  const LW = 6;

  const TAU = Math.PI * 2;
  const circle = (c, x, y, r) => { c.beginPath(); c.arc(x, y, r, 0, TAU); c.stroke(); };
  const dot = (c, x, y, r) => { c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); };
  const line = (c, pts) => { c.beginPath(); c.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]); c.stroke(); };
  const arc = (c, x, y, r, a0, a1) => { c.beginPath(); c.arc(x, y, r, a0, a1); c.stroke(); };
  const face = (c) => circle(c, 64, 64, 54);
  const text = (c, s, size) => {
    c.font = `bold ${size}px sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(s, 64, 68);
  };

  // Each draws white on a 128x128 canvas with lineWidth LW.
  const DRAW = {
    laugh: (c) => {
      face(c);
      arc(c, 44, 54, 10, Math.PI * 1.1, Math.PI * 1.9); // ^ ^ squeezed eyes
      arc(c, 84, 54, 10, Math.PI * 1.1, Math.PI * 1.9);
      c.beginPath(); c.moveTo(36, 72); c.lineTo(92, 72); c.arc(64, 72, 28, 0, Math.PI); c.closePath(); c.stroke(); // big D mouth
    },
    smile: (c) => { face(c); dot(c, 46, 50, 7); dot(c, 82, 50, 7); arc(c, 64, 64, 30, Math.PI * 0.2, Math.PI * 0.8); },
    sad: (c) => { face(c); dot(c, 46, 52, 7); dot(c, 82, 52, 7); arc(c, 64, 104, 28, Math.PI * 1.25, Math.PI * 1.75); },
    wink: (c) => { face(c); line(c, [36, 50, 54, 50]); dot(c, 82, 50, 7); arc(c, 64, 64, 30, Math.PI * 0.2, Math.PI * 0.8); },
    surprised: (c) => { face(c); dot(c, 46, 48, 7); dot(c, 82, 48, 7); circle(c, 64, 86, 12); },
    cool: (c) => {
      face(c);
      c.beginPath(); c.roundRect(28, 42, 30, 18, 6); c.roundRect(70, 42, 30, 18, 6); c.fill();
      line(c, [58, 48, 70, 48]);
      arc(c, 64, 70, 22, Math.PI * 0.25, Math.PI * 0.75);
    },
    angry: (c) => { face(c); line(c, [34, 40, 54, 50]); line(c, [94, 40, 74, 50]); dot(c, 46, 58, 6); dot(c, 82, 58, 6); arc(c, 64, 108, 26, Math.PI * 1.3, Math.PI * 1.7); },
    heart: (c) => {
      c.beginPath();
      c.moveTo(64, 108);
      c.bezierCurveTo(14, 74, 14, 26, 64, 40);
      c.bezierCurveTo(114, 26, 114, 74, 64, 108);
      c.stroke();
    },
    check: (c) => line(c, [24, 66, 52, 94, 106, 32]),
    cross: (c) => { line(c, [30, 30, 98, 98]); line(c, [98, 30, 30, 98]); },
    question: (c) => text(c, '?', 112),
    exclaim: (c) => text(c, '!', 112),
    star: (c) => {
      const p = [];
      for (let i = 0; i <= 10; i++) {
        const r = i % 2 ? 22 : 54;
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        p.push(64 + Math.cos(a) * r, 66 + Math.sin(a) * r);
      }
      line(c, p);
    },
    sun: (c) => {
      circle(c, 64, 64, 24);
      for (let i = 0; i < 8; i++) {
        const a = (i * TAU) / 8;
        line(c, [64 + Math.cos(a) * 36, 64 + Math.sin(a) * 36, 64 + Math.cos(a) * 54, 64 + Math.sin(a) * 54]);
      }
    },
    moon: (c) => { c.beginPath(); c.arc(64, 64, 46, Math.PI * 0.35, Math.PI * 1.65); c.arc(84, 54, 38, Math.PI * 1.55, Math.PI * 0.45, true); c.closePath(); c.stroke(); },
    note: (c) => {
      c.beginPath(); c.ellipse(44, 96, 16, 12, -0.4, 0, TAU); c.fill();
      c.beginPath(); c.ellipse(92, 84, 16, 12, -0.4, 0, TAU); c.fill();
      line(c, [58, 94, 58, 26, 106, 16, 106, 82]);
      line(c, [58, 40, 106, 30]);
    },
    idea: (c) => {
      c.beginPath(); c.arc(64, 50, 34, Math.PI * 0.8, Math.PI * 2.2); c.lineTo(78, 92); c.lineTo(50, 92); c.closePath(); c.stroke();
      line(c, [50, 104, 78, 104]); line(c, [54, 116, 74, 116]);
    },
    sleep: (c) => { c.font = 'bold 44px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('z', 34, 96); c.font = 'bold 60px sans-serif'; c.fillText('Z', 64, 66); c.font = 'bold 78px sans-serif'; c.fillText('Z', 100, 34); },
    up: (c) => line(c, [64, 112, 64, 20, 30, 54, 64, 20, 98, 54]),
    down: (c) => line(c, [64, 16, 64, 108, 30, 74, 64, 108, 98, 74]),
    left: (c) => line(c, [112, 64, 20, 64, 54, 30, 20, 64, 54, 98]),
    right: (c) => line(c, [16, 64, 108, 64, 74, 30, 108, 64, 74, 98]),
    infinity: (c) => {
      const p = [];
      for (let i = 0; i <= 80; i++) {
        const t = (i / 80) * TAU;
        const d = 1 + Math.sin(t) ** 2;
        p.push(64 + (52 * Math.cos(t)) / d, 64 + (52 * Math.sin(t) * Math.cos(t)) / d);
      }
      line(c, p);
    },
    clock: (c) => { circle(c, 64, 64, 52); line(c, [64, 64, 64, 30]); line(c, [64, 64, 88, 76]); },
    bolt: (c) => line(c, [76, 10, 38, 70, 66, 70, 50, 118, 92, 52, 62, 52, 76, 10]),
    ring: (c) => circle(c, 64, 64, 50),
  };

  const ALIASES = {
    laughing: 'laugh', lol: 'laugh', haha: 'laugh', giggle: 'laugh', happy: 'smile', smiley: 'smile',
    frown: 'sad', crying: 'sad', shocked: 'surprised', wow: 'surprised', sunglasses: 'cool', mad: 'angry',
    love: 'heart', yes: 'check', tick: 'check', done: 'check', no: 'cross', x: 'cross', wrong: 'cross',
    '?': 'question', '!': 'exclaim', music: 'note', bulb: 'idea', lightbulb: 'idea', zzz: 'sleep',
    'arrow up': 'up', 'arrow down': 'down', 'arrow left': 'left', 'arrow right': 'right',
    time: 'clock', lightning: 'bolt', zap: 'bolt', circle: 'ring', sphere: 'ring',
  };

  // Voice expression that goes with a shape (played through the robot chain).
  const EXPR = {
    laugh: 'giggle', smile: 'hum', wink: 'giggle', cool: 'hum', note: 'hum', sad: 'sigh', sleep: 'sigh',
    surprised: 'gasp', exclaim: 'gasp', angry: 'buzz', cross: 'buzz', check: 'ding', idea: 'ding', star: 'ding',
    heart: 'hum', question: 'hmm',
  };

  const NAMES = Object.keys(DRAW);

  // A shape request: a known name, or up to 3 letters/digits drawn as text.
  function resolve(name) {
    const raw = String(name || '').trim();
    const n = raw.toLowerCase().replace(/\s+/g, ' ');
    if (DRAW[n]) return n;
    if (ALIASES[n]) return ALIASES[n];
    if (/^[a-z0-9]{1,3}$/i.test(raw)) return `text:${raw.toUpperCase()}`;
    return null;
  }

  function exprFor(shape) {
    return EXPR[shape] || null;
  }

  // Returns a Float32Array of POINTS * 2 coordinates in -1..1 (y down).
  function points(shape, makeCanvas) {
    const cv = makeCanvas ? makeCanvas(SIZE, SIZE) : new OffscreenCanvas(SIZE, SIZE);
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.clearRect(0, 0, SIZE, SIZE);
    c.strokeStyle = '#fff';
    c.fillStyle = '#fff';
    c.lineWidth = LW;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (shape.startsWith('text:')) {
      const s = shape.slice(5);
      text(c, s, s.length === 1 ? 110 : s.length === 2 ? 76 : 54);
    } else if (DRAW[shape]) DRAW[shape](c);
    const img = c.getImageData(0, 0, SIZE, SIZE).data;
    const lit = [];
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (img[(y * SIZE + x) * 4 + 3] > 100) lit.push(x, y);
    const out = new Float32Array(POINTS * 2);
    const count = lit.length / 2;
    if (!count) return out;
    // Deterministic shuffle-ish spread so every particle gets a different spot.
    let s = 1234567;
    for (let i = 0; i < POINTS; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      const k = s % count;
      out[i * 2] = ((lit[k * 2] + ((s >>> 8) % 100) / 100) / SIZE) * 2 - 1;
      out[i * 2 + 1] = ((lit[k * 2 + 1] + ((s >>> 16) % 100) / 100) / SIZE) * 2 - 1;
    }
    return out;
  }

  return { NAMES, POINTS, resolve, exprFor, points, EXPR };
});

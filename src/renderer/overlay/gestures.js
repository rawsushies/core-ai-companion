// COre's body language: a library of cheap gestures built from the same two
// smoke arms and the body's position, so they cost nothing extra on the GPU.
//
// A gesture is sampled every frame: sample(name, elapsed s, t s, opts) returns
//   { done, arms: [left, right], body: { dx, dy, spin, squash } }
// Each arm is null (not used) or
//   { x, y,        hand target relative to the body centre, in radii (y down)
//     ext,         how far the arm is out, 0..1 (eased in and out by us)
//     fingers,     5 numbers 0 curled .. 1 straight: thumb, index, middle, ring, pinky
//     roll }       extra hand rotation in radians (for the right hand; mirrored)
// Arm specs are written for the RIGHT hand; left-hand specs are mirrored.
// UMD so the same file runs in the overlay, the main process and node --test.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Gestures = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const S = Math.sin;
  const OPEN = [1, 1, 1, 1, 1];
  const FIST = [0, 0, 0, 0, 0];

  // Smooth in for the first `a` seconds and out for the last `b` seconds.
  function env(e, dur, a = 0.35, b = 0.4) {
    return clamp(Math.min(e / a, (dur - e) / b), 0, 1);
  }

  const hand = (x, y, fingers, roll = 0) => ({ x, y, fingers, roll });
  const mirror = (h) => (h ? { ...h, x: -h.x } : null);
  const both = (h) => [mirror(h), h];
  const right = (h) => [null, h];
  const left = (h) => [mirror(h), null];

  const point = (dx, dy) => ({ dur: 2.2, arms: () => right(hand(dx * 2.2, dy * 2.2, [0.3, 1, 0, 0, 0])) });

  // name: { dur, arms(e, t, opts) -> [l, r], body?(e, t, opts) -> {...}, say? }
  const LIB = {
    wave: {
      dur: 2.4,
      arms: (e) => right(hand(1.55, -1.55, OPEN, S(e * 11) * 0.45)),
      body: (e) => ({ dy: -0.05 * Math.abs(S(e * 5.5)) }),
    },
    thumbsup: { dur: 2.0, arms: () => right(hand(1.9, -0.35, [1, 0, 0, 0, 0], -0.55)), body: (e) => ({ dy: -0.06 * env(e, 2.0) }) },
    thumbsdown: { dur: 2.0, arms: () => right(hand(1.9, 0.6, [1, 0, 0, 0, 0], 2.3)), body: (e) => ({ dy: 0.08 * env(e, 2.0) }) },
    shrug: {
      dur: 2.0,
      arms: (e) => both(hand(1.75, 0.35 - 0.25 * env(e, 2.0, 0.5, 0.5), OPEN, -0.9)),
      body: (e) => ({ dy: -0.12 * env(e, 2.0, 0.5, 0.6), squash: 0.05 * env(e, 2.0) }),
    },
    count: {
      dur: 3.2,
      arms: (e, t, o) => {
        const n = clamp(Math.round((o && o.n) || 3), 1, 5);
        const order = [1, 2, 3, 4, 0]; // index, middle, ring, pinky, thumb
        const shown = Math.min(n, Math.floor((e / 2.6) * n) + 1);
        const f = [0, 0, 0, 0, 0];
        for (let i = 0; i < shown; i++) f[order[i]] = 1;
        return right(hand(1.45, -1.45, f, 0));
      },
    },
    clap: {
      dur: 2.0,
      arms: (e) => {
        const a = Math.abs(S(e * 9));
        return both(hand(0.25 + 0.75 * a, 1.25, OPEN, -1.2));
      },
    },
    facepalm: {
      dur: 2.4,
      arms: () => right(hand(0.45, -0.25, OPEN, 2.4)),
      body: (e) => ({ dy: 0.1 * env(e, 2.4), spin: -0.4 * env(e, 2.4) }),
    },
    pointup: point(0.25, -1),
    pointdown: point(0.35, 1),
    pointleft: { dur: 2.2, arms: () => left(hand(2.3, -0.1, [0.3, 1, 0, 0, 0])) },
    pointright: point(1, -0.05),
    beckon: {
      dur: 2.4,
      arms: (e) => right(hand(1.5, 0.3, [0.3, 0.5 + 0.5 * S(e * 9), 0, 0, 0], -1.6)),
    },
    stop: { dur: 1.8, arms: () => right(hand(2.0, -0.2, OPEN, -1.45)), body: (e) => ({ dx: -0.08 * env(e, 1.8) }) },
    ok: { dur: 2.0, arms: () => right(hand(1.6, -1.1, [0.3, 0.25, 1, 1, 1], -0.3)) },
    peace: { dur: 2.0, arms: () => right(hand(1.5, -1.5, [0, 1, 1, 0, 0], 0)) },
    rock: { dur: 2.0, arms: (e) => right(hand(1.5, -1.6 + 0.1 * S(e * 10), [0.6, 1, 0, 0, 1], 0)), body: (e) => ({ dy: -0.06 * Math.abs(S(e * 10)) }) },
    heart: {
      dur: 2.6,
      arms: () => both(hand(0.4, -1.55, [1, 0.65, 0.65, 0.65, 0.65], -1.0)),
      body: (e) => ({ squash: -0.04 * S(e * 7) * env(e, 2.6) }),
    },
    think: {
      dur: 3.0,
      arms: () => right(hand(0.55, 0.95, [0.4, 0.55, 0, 0, 0], -2.0)),
      body: (e) => ({ spin: 0.6 * env(e, 3.0), dy: -0.04 * env(e, 3.0) }),
    },
    salute: { dur: 1.8, arms: () => right(hand(0.85, -1.15, OPEN, -1.9)), body: (e) => ({ dy: -0.05 * env(e, 1.8) }) },
    fistpump: {
      dur: 1.8,
      arms: (e) => right(hand(1.3, -1.3 - 0.45 * Math.max(0, S(e * 10)), FIST, 0)),
      body: (e) => ({ dy: -0.1 * Math.max(0, S(e * 10)) }),
    },
    celebrate: {
      dur: 2.6,
      arms: (e) => both(hand(1.3 + 0.15 * S(e * 12), -1.9, OPEN, S(e * 14) * 0.3)),
      body: (e) => ({ dy: -0.18 * Math.abs(S(e * 6)), spin: 1.2 * env(e, 2.6) }),
      pulse: 0.8,
    },
    juggle: {
      dur: 3.0,
      arms: (e) => [mirror(hand(1.2, -0.8 - 0.6 * Math.max(0, S(e * 8)), [0.6, 0.6, 0.6, 0.6, 0.6], -0.6)),
        hand(1.2, -0.8 - 0.6 * Math.max(0, S(e * 8 + Math.PI)), [0.6, 0.6, 0.6, 0.6, 0.6], -0.6)],
    },
    hug: {
      dur: 2.6,
      arms: (e) => {
        const close = clamp((e - 0.9) / 0.8, 0, 1);
        return both(hand(2.2 - 1.6 * close, 0.1, OPEN, -1.2 - 0.8 * close));
      },
      body: (e) => ({ squash: 0.06 * clamp((e - 0.9) / 0.8, 0, 1) * env(e, 2.6) }),
    },
    magic: {
      dur: 2.4,
      arms: (e) => both(hand(1.55, -0.6, [S(e * 15) * 0.5 + 0.5, S(e * 15 + 1) * 0.5 + 0.5, S(e * 15 + 2) * 0.5 + 0.5, S(e * 15 + 3) * 0.5 + 0.5, S(e * 15 + 4) * 0.5 + 0.5], -0.4)),
      body: (e) => ({ spin: 0.8 * env(e, 2.4) }),
    },
    flex: { dur: 2.0, arms: (e) => both(hand(1.4, -1.25 - 0.1 * S(e * 8), FIST, -0.4)), body: (e) => ({ squash: -0.05 * env(e, 2.0) }) },
    bow: { dur: 2.2, arms: () => [null, null], body: (e) => ({ dy: 0.35 * env(e, 2.2, 0.6, 0.7), squash: 0.08 * env(e, 2.2, 0.6, 0.7) }) },
    nod: { dur: 1.4, arms: () => [null, null], body: (e) => ({ dy: 0.12 * Math.max(0, S(e * 9)) * env(e, 1.4, 0.1, 0.3) }) },
    shake: { dur: 1.4, arms: () => [null, null], body: (e) => ({ dx: 0.13 * S(e * 12) * env(e, 1.4, 0.1, 0.3) }) },
    spin: { dur: 1.8, arms: () => [null, null], body: (e) => ({ spin: 4 * env(e, 1.8, 0.3, 0.8) }) },
    // Internal (not offered to the model): the meiosis split and the merge.
    split: {
      internal: true,
      dur: 1.8,
      arms: (e) => {
        const push = Math.min(1, e / 1.1);
        return both(hand(0.5 + 1.5 * push, -0.1 + 0.2 * Math.sin(e * 6), OPEN, -1.4));
      },
      body: (e) => ({ dx: 0.12 * Math.sin(e * 22) * env(e, 1.8, 0.2, 0.5), squash: -0.1 * env(e, 1.8, 0.4, 0.5) }),
      pulse: 1.1,
    },
    merge: {
      internal: true,
      dur: 1.4,
      arms: (e) => both(hand(2.0 - 1.4 * Math.min(1, e / 1.0), 0, OPEN, -1.2 - Math.min(1, e) * 0.6)),
      body: (e) => ({ squash: 0.08 * env(e, 1.4) }),
      pulse: 0.9,
    },
    bounce: { dur: 1.6, arms: () => [null, null], body: (e) => ({ dy: -0.3 * Math.abs(S(e * 6)) * env(e, 1.6, 0.1, 0.3), squash: 0.05 * S(e * 12) }) },
  };

  const ALIASES = {
    'thumbs up': 'thumbsup', 'thumbs-up': 'thumbsup', thumb: 'thumbsup', like: 'thumbsup',
    'thumbs down': 'thumbsdown', 'thumbs-down': 'thumbsdown',
    hi: 'wave', hello: 'wave', bye: 'wave', goodbye: 'wave',
    'point up': 'pointup', 'point down': 'pointdown', 'point left': 'pointleft', 'point right': 'pointright',
    halt: 'stop', okay: 'ok', 'ok sign': 'ok', victory: 'peace', horns: 'rock',
    'heart hands': 'heart', love: 'heart', thinking: 'think', hmm: 'think',
    'fist pump': 'fistpump', yes: 'nod', no: 'shake', party: 'celebrate', cheer: 'celebrate',
    hooray: 'celebrate', strong: 'flex', sparkle: 'magic', jump: 'bounce', hop: 'bounce',
  };

  const NAMES = Object.keys(LIB).filter((k) => !LIB[k].internal);

  function resolve(name) {
    const n = String(name || '').toLowerCase().trim().replace(/\s+/g, ' ');
    if (LIB[n]) return n;
    if (ALIASES[n]) return ALIASES[n];
    const squashed = n.replace(/[\s_-]/g, '');
    return LIB[squashed] ? squashed : null;
  }

  function duration(name) {
    const g = LIB[resolve(name)];
    return g ? g.dur : 0;
  }

  function sample(name, e, t, opts) {
    const key = resolve(name);
    const g = LIB[key];
    if (!g) return { done: true, arms: [null, null], body: {} };
    const done = e >= g.dur;
    const k = env(e, g.dur);
    const arms = g.arms(e, t, opts || {}).map((a) => (a ? { ...a, ext: k } : null));
    const b = g.body ? g.body(e, t, opts || {}) : {};
    return { done, arms, body: { dx: b.dx || 0, dy: b.dy || 0, spin: b.spin || 0, squash: b.squash || 0 }, pulse: g.pulse || 0 };
  }

  // A gesture that fits a spoken sentence, or null. Used sparingly by the
  // overlay when the model didn't choose one itself.
  const AUTO = [
    [/^(hi|hello|hey|good (morning|afternoon|evening)|greetings)\b|\b(goodbye|bye|see you|farewell)\b/i, 'wave'],
    [/\b(congratulations|congrats|we did it|nailed it|hooray|woohoo|you did it)\b/i, 'celebrate'],
    [/\b(great job|well done|nice work|good job|perfect|excellent|awesome|brilliant)\b/i, 'thumbsup'],
    [/\b(i (don'?t|do not) know|who knows|no idea|beats me|not sure)\b/i, 'shrug'],
    [/\b(let me think|hmm+|thinking about|good question)\b/i, 'think'],
    [/\b(wait|hold on|stop right there|careful)\b/i, 'stop'],
    [/\b(sorry|my mistake|my bad|oops|ugh)\b/i, 'facepalm'],
    [/\b(thank you|thanks|love (it|that|you))\b/i, 'heart'],
    [/\b(first|step one|number one)\b/i, 'count', { n: 1 }],
    [/\b(two things|second|secondly)\b/i, 'count', { n: 2 }],
    [/\b(three things|third|thirdly)\b/i, 'count', { n: 3 }],
    [/^(yes|yep|yeah|exactly|indeed|correct|right)\b/i, 'nod'],
    [/^(no|nope|nah)\b/i, 'shake'],
    [/\b(let'?s go|let us go|you got this)\b/i, 'fistpump'],
    [/\b(ta-?da|voila|magic)\b/i, 'magic'],
    [/\b(come here|come closer|over here)\b/i, 'beckon'],
  ];

  function autoGesture(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    for (const [re, name, opts] of AUTO) if (re.test(s)) return { name, opts: opts || {} };
    return null;
  }

  return { NAMES, LIB, resolve, duration, sample, autoGesture, env };
});

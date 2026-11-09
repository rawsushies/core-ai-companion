// COre overlay: wires the body (motion), the look (orb-gl), the voice and the
// microphone together and talks to the main process through window.core.
// Opened in a normal browser (no window.core) it runs a demo instead.
(function () {
  'use strict';

  const M = window.Motion;
  const S = window.Stage;
  const G = window.Gestures;
  const SH = window.Shapes;
  const bridge = window.core || null;
  const params = new URLSearchParams(location.search);

  // State colours (linear-ish RGB) and glow. COre's own colour is green.
  const MODES = {
    idle:      { tint: [0.24, 1.00, 0.52], glow: 0.10 },
    listening: { tint: [0.20, 0.85, 1.00], glow: 0.55 },
    thinking:  { tint: [0.62, 0.42, 1.00], glow: 0.40 },
    speaking:  { tint: [0.40, 1.00, 0.66], glow: 0.30 },
  };
  // Moods set by the model with [[mood ...]]: a colour lean, energy and motion.
  const MOODS = {
    happy:   { tint: [0.60, 1.00, 0.30], energy: 0.15, bob: 1.0 },
    amused:  { tint: [0.30, 1.00, 0.78], energy: 0.10, bob: 0.6 },
    curious: { tint: [0.25, 0.85, 1.00], energy: 0.05, bob: 0.0, swirl: 0.45 },
    annoyed: { tint: [1.00, 0.20, 0.04], energy: 0.20, bob: 0.0, flicker: 1, weight: 0.92 },
    excited: { tint: [0.90, 1.00, 0.25], energy: 0.35, bob: 1.6 },
    sad:     { tint: [0.35, 0.50, 1.00], energy: -0.1, bob: -1.0, weight: 0.75 },
    calm:    { tint: [0.30, 0.90, 0.70], energy: -0.05, bob: 0.0 },
  };
  // Smoke colour themes: [idle, speaking].
  const THEMES = {
    emerald: [[0.24, 1.00, 0.52], [0.40, 1.00, 0.66]],
    ice:     [[0.25, 0.80, 1.00], [0.45, 0.88, 1.00]],
    ember:   [[1.00, 0.48, 0.14], [1.00, 0.64, 0.30]],
    violet:  [[0.70, 0.40, 1.00], [0.80, 0.56, 1.00]],
    gold:    [[1.00, 0.80, 0.22], [1.00, 0.90, 0.45]],
    rose:    [[1.00, 0.38, 0.62], [1.00, 0.55, 0.74]],
    mono:    [[0.80, 0.86, 0.95], [0.95, 0.97, 1.00]],
  };
  const reducedMotionOS = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function reduceMotion() {
    const r = cfg.a11y && cfg.a11y.reduceMotion;
    return r === 'on' || (r !== 'off' && reducedMotionOS);
  }

  // How each mood colours the voice (playback rate: tempo and pitch together).
  const MOOD_VOICE = { happy: 1.03, amused: 1.02, curious: 1.01, annoyed: 1.03, excited: 1.07, sad: 0.94, calm: 0.97 };

  const ATTENTION = {
    info:    [0.28, 0.58, 1.00],
    success: [0.80, 1.00, 0.30],
    warn:    [1.00, 0.62, 0.12],
    urgent:  [1.00, 0.16, 0.22],
  };

  let cfg = { orb: { style: 'smoke', radius: 60, particles: 24000, renderScale: 1, home: null, backdrop: 'auto' }, voice: { tts: true }, lightTheme: false };
  let light = 0;
  let dockVisible = false;
  let lastAnchorSent = 0;
  // Coordinates: COre's logic works in display coordinates (the whole screen,
  // view). The window only covers `stage`, so drawing subtracts stage.x/y.
  let view = { w: innerWidth, h: innerHeight };
  let stage = { x: 0, y: 0, w: innerWidth, h: innerHeight };
  const stageState = { bigSince: 0 };
  let lastStageReq = 0;
  let lastDraw = 0;
  let renderer;
  let body;
  let home;
  let mode = 'idle';
  let attention = null; // { level, since }
  let hoverSince = 0;
  let listenLevel = 0;
  let pointing = null; // { x, y, park, startedAt, until, arm }
  let explainUntil = 0;
  let lastGestureAt = 0;
  // Body language from the gesture library: { name, start, opts, freeze }
  let act = null;
  let actBody = { dx: 0, dy: 0, spin: 0, squash: 0 };
  let lastModelGesture = 0;
  let lastAutoGesture = 0;
  // Shape-shifting: { name, start, dur } while the smoke holds a shape.
  let shapeAct = null;
  let shapeW = 0;
  const shapeCache = new Map();
  const vis = { tint: MODES.idle.tint.slice(), glow: 0.14, think: 0, halo: 0, listen: 0, aura: 0.78 };
  let auraC = null; // display coordinates; trails the body like the smoke does
  let mood = null; // { name, since }
  let moodW = 0; // eased mood weight 0..1
  let cursor = null; // display coordinates of a nearby cursor
  let noticeKick = 0;
  // Animations. form: 0 scattered .. 1 formed (assemble on start, dissolve on
  // hide). pulse: one shockwave at a time { x, y (display), t0, strength }.
  const anim = { form: 0, formTarget: 1, formVel: 0, pulse: null, spin: 0, spinUntil: 0, inhale: 0, listenStart: 0, nextIdle: performance.now() + 30000 };

  function pulseAt(x, y, strength = 1) {
    anim.pulse = { x, y, t0: performance.now(), strength };
  }

  const canvas = document.getElementById('orb');
  const caption = document.getElementById('caption');

  const voice = new window.Voice(cfg.voice, {
    onSay: (text, ms) => {
      showCaption(text);
      if (text && bridge) bridge.spoken(text, ms); // keeps the chat text in step with the voice
      if (text) maybeAutoGesture(text);
    },
    onSpeakStart: () => setMode('speaking'),
    // Any finished turn returns to idle, including silent or empty replies.
    onIdle: () => {
      if (mode === 'speaking' || mode === 'thinking') setMode('idle');
      if (bridge) bridge.speechIdle();
    },
  });

  // Hands-free: wake phrase and barge-in (only when enabled in settings).
  let wake = null;
  let wakeBusyUntil = 0;
  function syncWake() {
    const want = !!(bridge && !cfg.clone && cfg.voice && cfg.voice.wakeWord);
    if (want && !wake) {
      wake = new window.WakeListener({
        canCheck: () => performance.now() > wakeBusyUntil,
        onPhrase: (audio) => { wakeBusyUntil = performance.now() + 4000; bridge.wakeCheck(audio); },
        isSpeaking: () => voice.speaking,
        bargeIn: () => cfg.voice.bargeIn !== false,
        onBargeIn: () => { stopAll(); bridge.bargeIn(); },
      });
      wake.start();
    } else if (!want && wake) {
      wake.stop();
      wake = null;
    }
  }

  const listener = new window.Listener({
    onLevel: (v) => { listenLevel = v; },
    onAudio: (audio, meta) => {
      if (wake) wake.pause(false);
      setMode('thinking');
      if (body) pulseAt(body.pos.x, body.pos.y, 0.5); // "got it" the moment you stop talking
      if (bridge) bridge.sendAudio(audio, !!meta.withScreen);
    },
    onCancel: (reason) => {
      if (wake) wake.pause(false);
      setMode('idle');
      if (bridge) bridge.listenCancelled(reason);
    },
  });

  // ------------------------------------------------------------ state

  function setMode(m) {
    if (!MODES[m]) return;
    mode = m;
  }
  // Read-only peek used by the end-to-end tests.
  window.__coreMode = () => mode;
  window.__coreGesture = (g) => gesture(g); // test hook: { name: 'point', x, y } | { name: 'explain' }

  function setAttention(a) {
    attention = a && ATTENTION[a.level] ? { level: a.level, since: performance.now() } : null;
    if (attention && body) pulseAt(body.pos.x, body.pos.y, a.level === 'urgent' ? 1.4 : 1); // shockwave on arrival
  }

  function acknowledge() {
    attention = null;
  }

  function showCaption(text) {
    if (!text || (cfg.a11y && cfg.a11y.captions === false)) {
      caption.classList.remove('show');
      return;
    }
    caption.textContent = text;
    caption.classList.add('show');
  }

  // ------------------------------------------------------------ gestures

  function point(x, y) {
    const r = body.r;
    const park = M.parkFor({ x, y }, r, view.w, view.h);
    // Use the arm on the side facing the target.
    const armIdx = x < park.x ? 0 : 1;
    const arm = body.arms[armIdx];
    arm.mode = 'point';
    arm.goal = 0;
    arm.target = { x, y };
    const other = body.arms[1 - armIdx];
    if (other.mode === 'point') other.goal = 0;
    const now = performance.now();
    pointing = { x, y, park, startedAt: now, until: now + 4800, arm: armIdx };
    lastGestureAt = now;
  }

  function explain() {
    const now = performance.now();
    explainUntil = now + 2800;
    lastGestureAt = now;
    body.arms.forEach((arm, i) => {
      if (pointing && pointing.arm === i) return;
      arm.mode = 'explain';
      arm.goal = 1;
    });
  }

  function startGesture(name, opts = {}) {
    const key = G.resolve(name);
    if (!key || !body) return false;
    if (pointing && /^point/.test(key)) return false; // already pointing at the real thing
    act = { name: key, start: performance.now(), opts };
    explainUntil = 0;
    lastGestureAt = performance.now();
    if (G.LIB[key].pulse) pulseAt(body.pos.x, body.pos.y, G.LIB[key].pulse);
    return true;
  }

  // When the model didn't pick a gesture, sometimes add one that fits what
  // is being said (a wave for hello, a shrug for "no idea"...). Sparing on
  // purpose: at most one every 7 s.
  function maybeAutoGesture(text) {
    const now = performance.now();
    if (reduceMotion() || act || pointing || body.dragging || now - lastModelGesture < 5000 || now - lastAutoGesture < 7000) return;
    if (/\b(ha\s*){2,}|\b(lol|hehe+)\b/i.test(text) && !shapeAct) {
      lastAutoGesture = now;
      if (formShape('laugh')) voice.expr('giggle');
      return;
    }
    const g = G.autoGesture(text);
    if (!g || Math.random() > 0.75) return;
    lastAutoGesture = now;
    startGesture(g.name, g.opts);
  }

  function updateGesture(now, t) {
    if (!act) { actBody = { dx: 0, dy: 0, spin: 0, squash: 0 }; return; }
    const e = act.freeze !== undefined ? act.freeze : (now - act.start) / 1000;
    const g = G.sample(act.name, e, t, act.opts);
    const r = body.r;
    body.arms.forEach((arm, i) => {
      if (pointing && pointing.arm === i) return;
      const h = g.done ? null : g.arms[i];
      if (h) {
        arm.mode = 'gesture';
        arm.goal = h.ext;
        arm.target = { x: body.pos.x + h.x * r, y: body.pos.y + h.y * r };
        arm.fingers = h.fingers;
        arm.roll = h.roll;
      } else if (arm.mode === 'gesture') {
        arm.goal = 0;
      }
    });
    actBody = g.done ? { dx: 0, dy: 0, spin: 0, squash: 0 } : g.body;
    if (g.done) act = null;
  }

  // Pull the smoke into a shape (emoji, symbol, letters) for a few seconds.
  function formShape(name, dur = 3.4) {
    const key = SH.resolve(name);
    if (!key || !renderer || !renderer.setShape) return null;
    try {
      if (!shapeCache.has(key)) shapeCache.set(key, SH.points(key));
      renderer.setShape(shapeCache.get(key));
    } catch (e) { console.error('shape failed', e); return null; }
    shapeAct = { name: key, start: performance.now(), dur: dur * 1000 };
    if (shapeCache.size > 24) shapeCache.delete(shapeCache.keys().next().value);
    return key;
  }

  function gesture(item) {
    // A real point wins over a pointing gesture (the model sometimes sends both).
    if (item.name === 'point') { if (act && /^point|beckon/.test(act.name)) act = null; point(item.x, item.y); }
    else if (item.name === 'explain') explain();
    else if (item.name === 'form') { lastModelGesture = performance.now(); formShape(item.shape); }
    else if (item.name === 'gesture') { lastModelGesture = performance.now(); startGesture(item.gesture, { n: item.n }); }
    else if (item.name === 'mood' && MOODS[item.mood]) { mood = { name: item.mood, since: performance.now() }; voice.moodRate = MOOD_VOICE[item.mood] || 1; }
  }

  function onSpeakItem(item) {
    if (item.type === 'say') voice.say(item.text, item.audio ? { audio: item.audio, sampleRate: item.sampleRate, rate: item.rate } : null);
    else if (item.type === 'gesture' && item.name === 'form') {
      // The shape appears with its sound (a giggle with the laughing face...)
      // and the next sentence waits for the sound to finish.
      const ex = SH.exprFor(SH.resolve(item.shape));
      voice.action(() => { gesture(item); if (ex) voice.expr(ex); });
      if (ex && voice.cfg.tts !== false) voice.wait(window.Voice.EXPR_MS[ex] || 0);
    } else if (item.type === 'gesture') voice.action(() => gesture(item));
    else if (item.type === 'end') voice.end();
  }

  function stopAll() {
    voice.stop();
    pointing = null;
    explainUntil = 0;
    act = null;
    shapeAct = null;
    body.arms.forEach((a) => { a.goal = 0; });
    if (mode === 'speaking' || mode === 'thinking') setMode('idle');
  }

  // ------------------------------------------------------------ behaviour

  function updateBehaviour(now, t) {
    const r = body.r;
    if (body.dragging) return;

    if (pointing) {
      body.target = pointing.park;
      const arrived = Math.hypot(body.pos.x - pointing.park.x, body.pos.y - pointing.park.y) < r * 1.2;
      const arm = body.arms[pointing.arm];
      // Re-assert every frame: motion switches a retracted arm off.
      arm.mode = 'point';
      arm.target = { x: pointing.x, y: pointing.y };
      if (arrived || now - pointing.startedAt > 900) arm.goal = 1;
      // Keep pointing while still talking about it, up to a limit.
      if (now > pointing.until && (!voice.speaking || now - pointing.startedAt > 9000)) {
        arm.goal = 0;
        pointing = null;
      }
    } else if (now - lastGestureAt > 2500) {
      const w = M.wander(home, t);
      if (reduceMotion()) { w.x = home.x + (w.x - home.x) * 0.3; w.y = home.y + (w.y - home.y) * 0.3; } // calmer drift
      // Presence: lean gently toward a nearby cursor, as if noticing you.
      if (cursor) {
        const dx = cursor.x - home.x;
        const dy = cursor.y - home.y;
        const d = Math.hypot(dx, dy) || 1;
        const lean = Math.min(r * 0.45, d * 0.12);
        w.x += (dx / d) * lean;
        w.y += (dy / d) * lean;
      }
      // Mood motion: a bounce when happy/excited, a slow sink when sad.
      const md = mood && MOODS[mood.name];
      if (md && md.bob) w.y -= Math.abs(Math.sin(t * 5.2)) * md.bob * r * 0.12 * moodW - (md.bob < 0 ? r * 0.15 * moodW : 0);
      body.target = w;
    }

    if (explainUntil && now > explainUntil) {
      explainUntil = 0;
      body.arms.forEach((a) => { if (a.mode === 'explain') a.goal = 0; });
    } else if (explainUntil) {
      body.arms.forEach((a, i) => {
        if (pointing && pointing.arm === i) return;
        a.mode = 'explain';
        a.goal = 1;
      });
    }

    // Idle life: every 25-45 s with nothing going on, do something small.
    const quiet = mode === 'idle' && !voice.speaking && !pointing && !explainUntil && !body.dragging && !mood && !attention;
    if (!quiet || reduceMotion()) anim.nextIdle = Math.max(anim.nextIdle, now + 8000);
    else if (now > anim.nextIdle) {
      const pick = Math.random();
      if (pick < 0.25) anim.spinUntil = now + 2200; // a slow spin
      else if (pick < 0.45) body.vel.y -= r * 9; // a little hop
      else if (pick < 0.6) pulseAt(body.pos.x, body.pos.y, 0.6); // a ripple
      else startGesture(['magic', 'juggle', 'bounce', 'think', 'flex', 'wave'][Math.floor(Math.random() * 6)]); // fidget
      anim.nextIdle = now + 25000 + Math.random() * 20000;
    }

    // Hovering the orb for a moment acknowledges a notification.
    if (attention && hoverSince && now - hoverSince > 700) acknowledge();
    // Informational colours fade on their own; warnings wait for you.
    if (attention && (attention.level === 'info' || attention.level === 'success') && now - attention.since > 12000) acknowledge();
  }

  function updateVisuals(dt, now) {
    const m = MODES[mode];
    // Helpers wear their own colour while idle or talking.
    const theme = THEMES[cfg.orb && cfg.orb.theme] || THEMES.emerald;
    let tint = (mode === 'idle' || mode === 'speaking')
      ? (cfg.clone ? cfg.clone.tint : theme[mode === 'idle' ? 0 : 1])
      : m.tint;
    let glow = m.glow;
    let halo = 0;
    if (attention) {
      // A finished helper keeps its own colour, just brighter with a halo.
      tint = cfg.clone && attention.level === 'success' ? cfg.clone.tint : ATTENTION[attention.level];
      glow = Math.max(glow, 0.55);
      halo = attention.level === 'urgent' ? 1 : 0.75;
    }
    // Mood: lasts ~9 s, eased in and out.
    if (mood && now - mood.since > 9000) { mood = null; voice.moodRate = 1; }
    moodW += ((mood ? 1 : 0) - moodW) * Math.min(1, dt * 3);
    const md = mood ? MOODS[mood.name] : null;
    if (md && !attention) {
      const w = (md.weight || 0.55) * moodW * (md.flicker ? 0.75 + 0.25 * Math.sin(now / 45) : 1);
      tint = tint.map((c, i) => c + (md.tint[i] - c) * w);
      glow += md.energy * moodW;
    }
    noticeKick *= Math.exp(-dt * 3);
    // Form springs toward its target (slight overshoot = a soft "pop" into shape).
    const [f, fv] = M.spring1(anim.form, anim.formVel, anim.formTarget, 16, 0.65, dt);
    anim.form = Math.max(0, Math.min(1.08, f));
    anim.formVel = fv;
    const spinTarget = (now < anim.spinUntil ? 2.4 : 0) + (mode === 'thinking' ? 0.8 : 0);
    anim.spin += (spinTarget - anim.spin) * Math.min(1, dt * 2.5);
    // Listening: a quick inhale, then a gentle hold.
    const inhaleTarget = mode === 'listening' ? (now - anim.listenStart < 450 ? 1 : 0.35) : 0;
    anim.inhale += (inhaleTarget - anim.inhale) * Math.min(1, dt * 8);
    if (anim.pulse && now - anim.pulse.t0 > 2500) anim.pulse = null;
    glow += noticeKick * 0.35;
    const k = Math.min(1, dt * 4);
    for (let i = 0; i < 3; i++) vis.tint[i] += (tint[i] - vis.tint[i]) * k;
    vis.glow += (glow - vis.glow) * k;
    vis.halo += (halo - vis.halo) * k;
    vis.think += ((mode === 'thinking' ? 1 : md && md.swirl ? md.swirl * moodW : 0) - vis.think) * k;
    vis.listen += ((mode === 'listening' ? Math.max(0.25, listenLevel) : 0) - vis.listen) * Math.min(1, dt * 12);
  }

  // ------------------------------------------------------------ loop

  let last = performance.now();
  let lastBoundsSent = 0;
  const t0 = last;

  // Is anything happening that needs full frame rate?
  function isActive() {
    return mode !== 'idle' || voice.speaking || !!pointing || !!explainUntil || !!act || !!shapeAct || shapeW > 0.01 || body.dragging || !!attention || !!mood || noticeKick > 0.05
      || anim.form < 0.995 || !!anim.pulse || anim.spin > 0.05 || anim.inhale > 0.02
      || Math.hypot(body.vel.x, body.vel.y) > 30 || body.arms.some((a) => a.extend > 0.02);
  }

  function frame(now) {
    // Idle: draw at idleFps to keep GPU and desktop compositing light.
    const idleFps = (cfg.orb && cfg.orb.idleFps) || 30;
    if (!isActive() && now - lastDraw < 1000 / idleFps - 2) {
      requestAnimationFrame(frame);
      return;
    }
    lastDraw = now;
    const dt = Math.min(0.1, (now - last) / 1000); // motion substeps keep long frames stable
    last = now;
    const t = (now - t0) / 1000;

    updateBehaviour(now, t);
    updateGesture(now, t);
    if (shapeAct && shapeAct.dur !== Infinity && now - shapeAct.start > shapeAct.dur) shapeAct = null;
    shapeW += ((shapeAct ? 1 : 0) - shapeW) * Math.min(1, dt * (shapeAct ? 3.2 : 2.2));
    M.step(body, dt);
    const md0 = mood ? MOODS[mood.name] : null;
    const amp = Math.min(1, voice.update(dt, t) * (1 + (md0 ? Math.max(0, md0.energy) * moodW : 0)));
    updateVisuals(dt, now);

    // A tiny shiver while speaking sells the "vibrating" voice.
    const jitter = reduceMotion() ? 0 : amp * body.r * 0.025;
    const pos = {
      x: body.pos.x + (Math.sin(t * 61) + Math.sin(t * 37)) * 0.5 * jitter + actBody.dx * body.r,
      y: body.pos.y + (Math.sin(t * 53 + 1) + Math.sin(t * 29)) * 0.5 * jitter + actBody.dy * body.r,
    };
    const shown = { ...body, pos };
    const arms = body.arms.map((a) => (a.mode === 'off' && a.extend < 0.02 ? null : M.armGeometry(shown, a, t)));
    const tailGap = Math.hypot(body.tail.x - body.pos.x, body.tail.y - body.pos.y);

    // The dark backing trails the smoke and fades out while moving fast, so it
    // never jumps ahead of the cloud (e.g. when dragging).
    if (!auraC) auraC = { x: body.pos.x, y: body.pos.y };
    const ak = 1 - Math.exp(-dt * 5);
    auraC.x += (body.pos.x - auraC.x) * ak;
    auraC.y += (body.pos.y - auraC.y) * ak;
    const speed = Math.hypot(body.vel.x, body.vel.y);
    const auraTarget = body.dragging ? 0 : 0.78 * (1 - Math.min(1, Math.max(0, (speed - body.r * 2) / (body.r * 8))));
    vis.aura += (auraTarget - vis.aura) * Math.min(1, dt * (auraTarget < vis.aura ? 10 : 2.5));

    updateStage(now, pos, arms);
    const ox = stage.x;
    const oy = stage.y;
    const local = (p) => ({ x: p.x - ox, y: p.y - oy });
    const localArms = arms.map((g) => (g ? { ...g, pts: g.pts.map(local) } : null));

    renderer.render({
      t,
      pos: local(pos),
      vel: body.vel,
      tail: local(body.tail),
      tailR: body.r * (0.35 + 0.2 * Math.min(1, tailGap / body.r)),
      r: body.r,
      amp,
      listen: vis.listen,
      think: vis.think,
      tint: vis.tint,
      glow: vis.glow,
      halo: vis.halo,
      light,
      arms: localArms,
      auraCenter: local(auraC),
      aura: vis.aura * Math.min(1, anim.form),
      form: Math.min(1, anim.form),
      pulse: anim.pulse ? { ...local(anim.pulse), age: (now - anim.pulse.t0) / 1000, strength: anim.pulse.strength } : null,
      spin: anim.spin + actBody.spin,
      shape: shapeW,
      inhale: Math.min(1, anim.inhale + Math.max(0, actBody.squash) * 4),
    });

    placeCaption(local(pos));

    if (bridge && now - lastBoundsSent > 100) {
      bridge.orbBounds({ x: body.pos.x, y: body.pos.y, r: body.r });
      lastBoundsSent = now;
    }
    // (The chat hides during a drag and reappears under the orb on drop.)
    requestAnimationFrame(frame);
  }

  // Grow the window when COre needs more room, shrink it when it's settled.
  function updateStage(now, pos, arms) {
    if (cfg.clone) return; // a helper's window is fixed; main places it
    // While dragging, check often and leave lots of room ahead of the orb so
    // the smoke is never clipped at the window edge.
    if (!bridge || now - lastStageReq < 80) return;
    const capShown = caption.classList.contains('show');
    const need = S.neededRect({
      pos,
      target: body.target,
      tail: body.tail,
      // While assembling or dissolving, the scattered smoke reaches further out.
      r: body.r * (1 + 1.3 * (1 - Math.min(1, anim.form))),
      arms,
      point: pointing ? { x: pointing.x, y: pointing.y } : null,
      caption: capShown ? { w: caption.offsetWidth, h: caption.offsetHeight, above: dockVisible } : null,
    });
    const settled = !pointing && !explainUntil && !body.dragging && Math.hypot(body.vel.x, body.vel.y) < 20
      && body.arms.every((a) => a.extend < 0.02);
    const next = S.decideSteady({ stage, need, view, r: body.r, now, settled, dragging: body.dragging, state: stageState });
    if (next) {
      lastStageReq = now;
      stage = { ...next }; // apply locally at once so drawing and window agree
      bridge.stageNeed(next);
    }
  }

  // Keep the caption on screen: centred under the orb, clamped to the edges,
  // and above the orb when there is no room below.
  function placeCaption(pos) {
    if (!caption.classList.contains('show')) return;
    const w = caption.offsetWidth;
    const h = caption.offsetHeight;
    const m = 12;
    const x = Math.min(Math.max(pos.x - w / 2, m), innerWidth - w - m);
    let y = pos.y + body.r * 1.55;
    if (dockVisible || y + h > innerHeight - m) y = pos.y - body.r * 1.55 - h;
    caption.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.max(m, y))}px)`;
  }

  // ------------------------------------------------------------ mouse

  // Playful touches: local reactions (no brain round trip), and main hears
  // about them so it knows you're around.
  let pokes = [];
  const reactions = [];
  window.__coreReactions = () => reactions.slice(); // test hook
  function react(kind) {
    const now = performance.now();
    reactions.push(kind);
    if (reactions.length > 50) reactions.shift();
    const quietVoice = voice.speaking || voice.busy;
    if (kind === 'pet') {
      mood = { name: 'happy', since: now };
      if (!quietVoice) voice.expr('hum');
      if (Math.random() < 0.35) formShape('heart', 2.4);
    } else if (kind === 'tickle') {
      formShape('laugh', 2.6);
      startGesture('magic');
      if (!quietVoice) voice.expr('giggle');
    } else if (kind === 'poke') {
      pokes = pokes.filter((t) => now - t < 8000).concat(now);
      startGesture('bounce');
      if (!quietVoice) voice.expr('gasp');
      if (pokes.length >= 3) { mood = { name: 'annoyed', since: now }; formShape('angry', 2.2); pokes = []; }
    } else if (kind === 'toss') {
      anim.spinUntil = now + 1800;
      if (!quietVoice) voice.expr('giggle');
    }
    if (bridge && bridge.interaction) bridge.interaction(kind);
  }

  function setupPointer() {
    let down = null;
    let lastClickAt = 0;
    let holdTimer = null;
    let holding = false;
    let trail = [];
    const touch = new window.Interactions.TouchDetector({ r: body.r });
    const toView = (e) => ({ x: e.clientX + stage.x, y: e.clientY + stage.y });

    // Ends a click or drag. Called from several signals because the window
    // resizes when a drag starts, which can drop pointer capture (then a
    // plain pointerup never arrives and COre would stay stuck "dragging").
    function release() {
      if (!down) return;
      const d = down;
      down = null;
      clearTimeout(holdTimer);
      if (holding) {
        // Hold-to-talk: letting go sends what you said.
        holding = false;
        if (bridge) bridge.holdTalk(false);
        return;
      }
      if (d.moved) {
        body.dragging = false;
        // A fast release tosses COre: it flies on and lands further along.
        const v = window.Interactions.releaseVelocity(trail);
        const sp = Math.hypot(v.x, v.y);
        if (sp > 1500) {
          const m = body.r * 1.8;
          body.target = {
            x: Math.min(view.w - m, Math.max(m, body.target.x + v.x * 0.2)),
            y: Math.min(view.h - m, Math.max(m, body.target.y + v.y * 0.2)),
          };
          body.vel = { x: v.x * 0.5, y: v.y * 0.5 };
          react('toss');
        }
        trail = [];
        home = { x: body.target.x, y: body.target.y };
        lastGestureAt = performance.now();
        if (bridge) { bridge.orbDrag(false); bridge.orbHome(home); bridge.orbAnchor({ ...home, r: body.r }); }
        pulseAt(body.target.x, body.target.y, 0.8); // a splash when dropped
      } else {
        acknowledge();
        pulseAt(d.x, d.y, 1); // a ripple from where you clicked
        const now = performance.now();
        // A quick second click is a poke; it also undoes the first click's
        // chat toggle, so the chat stays as it was.
        if (now - lastClickAt < 380) { react('poke'); lastClickAt = 0; } else lastClickAt = now;
        if (bridge) bridge.orbClick();
      }
    }

    canvas.addEventListener('pointerdown', (e) => {
      const p = toView(e);
      const d = Math.hypot(p.x - body.pos.x, p.y - body.pos.y);
      if (d > body.r * 1.45) return;
      down = { x: p.x, y: p.y, moved: false };
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      // Press and hold (without moving) to talk; let go to send.
      clearTimeout(holdTimer);
      if (bridge && !cfg.clone) {
        holdTimer = setTimeout(() => {
          if (down && !down.moved) { holding = true; pulseAt(body.pos.x, body.pos.y, 0.5); bridge.holdTalk(true); }
        }, 450);
      }
    });
    window.addEventListener('pointermove', (e) => {
      if (!down) {
        const p = toView(e);
        if (Math.hypot(p.x - body.pos.x, p.y - body.pos.y) < body.r * 1.45 && !body.dragging) {
          touch.r = body.r;
          const kind = touch.feed(p.x, p.y, e.timeStamp || performance.now());
          if (kind) react(kind);
        } else touch.reset();
        return;
      }
      if (e.buttons === 0) return release(); // button was released somewhere we didn't hear
      const p = toView(e);
      if (cfg.clone || holding) return; // helpers can't be dragged; holding = talking
      if (!down.moved && Math.hypot(p.x - down.x, p.y - down.y) > 6) {
        down.moved = true;
        clearTimeout(holdTimer);
        body.dragging = true;
        pointing = null;
        if (bridge) bridge.orbDrag(true);
      }
      if (down.moved) {
        body.target = { x: p.x, y: p.y };
        trail.push({ x: p.x, y: p.y, t: e.timeStamp || performance.now() });
        if (trail.length > 12) trail.shift();
      }
    });
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    canvas.addEventListener('lostpointercapture', () => { if (down && !down.moved) release(); });
    window.addEventListener('blur', release);
  }

  // ------------------------------------------------------------ boot

  function applyConfig(c) {
    if (!c) return;
    cfg = { ...cfg, ...c };
    const b = (cfg.orb && cfg.orb.backdrop) || 'auto';
    light = b === 'light' ? 1 : b === 'dark' ? 0 : (cfg.lightTheme ? 1 : 0);
    voice.setConfig(cfg.voice);
    if (typeof syncWake === 'function' && body) syncWake();
    if (c.view) view = { ...c.view };
    if (c.stage) stage = { ...c.stage };
    if (body) {
      body.r = cfg.orb.radius || 60;
      if (c.view) {
        placeHome();
        if (bridge) bridge.orbAnchor({ x: home.x, y: home.y, r: body.r });
      }
    }
  }

  function placeHome() {
    const r = cfg.orb.radius || 60;
    const h = cfg.orb.home;
    home = h && h.x > 0 && h.x < view.w && h.y > 0 && h.y < view.h ? { ...h } : (cfg.defaultHome || M.defaultHome(view.w, view.h, r));
  }

  async function boot() {
    if (bridge) applyConfig(await bridge.init());
    const style = params.get('style') || cfg.orb.style || 'smoke';
    try {
      renderer = style === 'liquid'
        ? new window.LiquidOrbRenderer(canvas, { renderScale: cfg.orb.renderScale || 1 })
        : new window.SmokeOrbRenderer(canvas, { renderScale: cfg.orb.renderScale || 1, particles: cfg.orb.particles || 24000 });
    } catch (err) {
      // No WebGL2 (blocklisted or missing GPU): main restarts in safe graphics
      // mode, which renders WebGL in software.
      if (bridge) bridge.rendererFailed(err.message);
      document.body.dataset.error = err.message;
      return;
    }
    placeHome();
    body = M.createBody({ x: home.x, y: home.y, r: cfg.orb.radius || 60 });
    // The window resizes whenever the stage changes; home is in display
    // coordinates and doesn't move with it.
    addEventListener('resize', () => renderer.resize());
    // A GPU reset (sleep/wake, driver update) loses the WebGL context; reload
    // the overlay so COre comes back instead of staying invisible.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (bridge) bridge.log('WebGL context lost, reloading overlay');
      setTimeout(() => location.reload(), 1000);
    });
    setupPointer();

    if (bridge) {
      bridge.onSpeakItem(onSpeakItem);
      bridge.onState((s) => setMode(s));
      bridge.onAttention(setAttention);
      bridge.onListenStart((meta) => { stopAll(); if (wake) wake.pause(true); setMode('listening'); anim.listenStart = performance.now(); listener.start(meta); });
      bridge.onWakeResult((ok) => { wakeBusyUntil = performance.now() + (ok ? 1500 : 300); });
      // Hide/show: dissolve into drifting smoke, then reassemble.
      bridge.onDissolve(() => { anim.formTarget = 0; });
      bridge.onAssemble(() => { anim.form = 0; anim.formVel = 0; anim.formTarget = 1; });
      bridge.onListenStop(() => listener.stop());
      // Moved to another monitor: reassemble at the new home.
      bridge.onRelocate((h) => {
        if (!h) return;
        home = { x: h.x, y: h.y };
        body.pos = { ...home }; body.tail = { ...home }; body.target = { ...home }; body.vel = { x: 0, y: 0 };
        auraC = null;
        anim.form = 0; anim.formVel = 0; anim.formTarget = 1;
      });
      bridge.onSpeechStop(stopAll);
      bridge.onHover((over) => { hoverSince = over ? performance.now() : 0; });
      bridge.onConfig(applyConfig);
      bridge.onDockVisible((v) => { dockVisible = !!v; });
      bridge.onStage((st) => { if (st) stage = { ...st }; });
      bridge.onCursor((c) => {
        const wasNear = cursor && Math.hypot(cursor.x - body.pos.x, cursor.y - body.pos.y) < body.r * 3;
        cursor = c;
        const isNear = c && Math.hypot(c.x - body.pos.x, c.y - body.pos.y) < body.r * 3;
        if (isNear && !wasNear) noticeKick = 1; // a little glow when it notices you
      });
      bridge.orbAnchor({ x: home.x, y: home.y, r: body.r });
    } else {
      demo();
    }
    syncWake();
    requestAnimationFrame((now) => {
      frame(now);
      if (bridge) bridge.ready(); // first frame drawn
    });
  }

  // ------------------------------------------------------------ demo

  function demo() {
    document.body.classList.add('demo');
    if (params.get('bg') === 'light') { document.body.style.background = '#eef0f4'; light = 1; }
    window.__coreDebug = () => ({ body, pointing, home, mode, renderer, inner: [innerWidth, innerHeight] });
    const help = document.getElementById('demo-help');
    if (help) help.hidden = false;
    let mouse = { x: innerWidth / 2, y: innerHeight / 2 };
    addEventListener('mousemove', (e) => { mouse = { x: e.clientX, y: e.clientY }; });
    const levels = Object.keys(ATTENTION);
    let li = -1;
    let gi = -1;
    let si = -1;
    addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'p') { voice.action(() => point(mouse.x, mouse.y)); voice.say('That spot, right there.'); voice.end(); }
      if (k === 'e') { voice.action(explain); voice.say('Here is the idea, in two parts.'); voice.end(); }
      if (k === 't') { voice.say("Hi, I'm COre. I live on your screen and I'm happy to help."); voice.end(); }
      if (k === 'l') setMode(mode === 'listening' ? 'idle' : 'listening');
      if (k === 'k') setMode(mode === 'thinking' ? 'idle' : 'thinking');
      if (k === 'n') { li = (li + 1) % (levels.length + 1); setAttention(li < levels.length ? { level: levels[li] } : null); }
      if (k === 'm') { home = { ...mouse }; lastGestureAt = 0; }
      const moodKeys = { 1: 'happy', 2: 'amused', 3: 'curious', 4: 'annoyed', 5: 'excited', 6: 'sad', 7: 'calm' };
      if (moodKeys[k]) gesture({ name: 'mood', mood: moodKeys[k] });
      if (k === 'w') pulseAt(body.pos.x, body.pos.y, 1);
      if (k === 's') anim.spinUntil = performance.now() + 2200;
      if (k === 'h') anim.formTarget = anim.formTarget ? 0 : 1;
      if (k === 'f') { si = (si + 1) % SH.NAMES.length; const n = SH.NAMES[si]; formShape(n); const ex = SH.exprFor(n); if (ex) voice.expr(ex); showCaption(n); }
      if (k === 'g') { gi = (gi + 1) % G.NAMES.length; startGesture(G.NAMES[gi], { n: 3 }); showCaption(G.NAMES[gi]); }
    });

    if (params.get('theme')) cfg.orb = { ...cfg.orb, theme: params.get('theme') };
    if (params.get('bg') === 'brand') document.body.style.background = '#05070A';
    // Deterministic poses for screenshots: ?pose=idle|speaking|point|explain|attention|move
    const rq = Number(params.get('r'));
    if (rq > 8) body.r = rq;
    const pose = params.get('pose');
    if (pose) {
      voice.cfg.tts = false;
      const c = { x: innerWidth / 2, y: innerHeight / 2 };
      home = c;
      body.pos = { ...c }; body.tail = { ...c }; body.target = { ...c };
      if (pose === 'speaking') { voice.say('Talking talking talking talking, a long sentence so the orb keeps vibrating for the capture.'); }
      if (pose === 'listening') setMode('listening');
      if (pose === 'thinking') setMode('thinking');
      if (pose === 'explain') { explain(); explainUntil = performance.now() + 60000; voice.say('Explaining a long long idea for the screenshot capture right now.'); }
      if (pose === 'point') { point(c.x - 330, c.y - 170); pointing.until = performance.now() + 60000; }
      if (pose === 'attention') setAttention({ level: params.get('level') || 'warn' });
      if (pose === 'assemble') { anim.form = 0; anim.formTarget = 0; setTimeout(() => { anim.formTarget = 1; }, Number(params.get('at') || 0)); }
      if (pose === 'pulse') setTimeout(() => pulseAt(c.x, c.y, 1.2), Number(params.get('at') || 0));
      if (pose === 'mood') { gesture({ name: 'mood', mood: params.get('mood') || 'happy' }); mood.since = performance.now() + 60000; }
      if (pose === 'form') setTimeout(() => formShape(params.get('shape') || 'laugh', Infinity), Number(params.get('at') || 300));
      if (pose === 'gesture') {
        startGesture(params.get('g') || 'wave', { n: Number(params.get('n')) || 3 });
        act.freeze = Number(params.get('at') || 1);
        act.start = 0;
      }
      if (pose === 'move') { body.pos = { x: c.x - 260, y: c.y + 40 }; body.tail = { ...body.pos }; body.target = { x: c.x + 220, y: c.y - 20 }; lastGestureAt = performance.now() + 60000; }
    }
  }

  boot();
})();

// COre overlay: wires the body (motion), the look (orb-gl), the voice and the
// microphone together and talks to the main process through window.core.
// Opened in a normal browser (no window.core) it runs a demo instead.
(function () {
  'use strict';

  const M = window.Motion;
  const S = window.Stage;
  const bridge = window.core || null;
  const params = new URLSearchParams(location.search);

  // State colours (linear-ish RGB) and glow. COre's own colour is green.
  const MODES = {
    idle:      { tint: [0.24, 1.00, 0.52], glow: 0.10 },
    listening: { tint: [0.20, 0.85, 1.00], glow: 0.55 },
    thinking:  { tint: [0.62, 0.42, 1.00], glow: 0.40 },
    speaking:  { tint: [0.40, 1.00, 0.66], glow: 0.30 },
  };
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
  const vis = { tint: MODES.idle.tint.slice(), glow: 0.14, think: 0, halo: 0, listen: 0 };

  const canvas = document.getElementById('orb');
  const caption = document.getElementById('caption');

  const voice = new window.Voice(cfg.voice, {
    onSay: (text) => showCaption(text),
    onSpeakStart: () => setMode('speaking'),
    // Any finished turn returns to idle, including silent or empty replies.
    onIdle: () => { if (mode === 'speaking' || mode === 'thinking') setMode('idle'); },
  });

  const listener = new window.Listener({
    onLevel: (v) => { listenLevel = v; },
    onAudio: (audio, meta) => {
      setMode('thinking');
      if (bridge) bridge.sendAudio(audio, !!meta.withScreen);
    },
    onCancel: (reason) => {
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
  }

  function acknowledge() {
    attention = null;
  }

  function showCaption(text) {
    if (!text) {
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

  function gesture(item) {
    if (item.name === 'point') point(item.x, item.y);
    else if (item.name === 'explain') explain();
  }

  function onSpeakItem(item) {
    if (item.type === 'say') voice.say(item.text, item.audio ? { audio: item.audio, sampleRate: item.sampleRate, rate: item.rate } : null);
    else if (item.type === 'gesture') voice.action(() => gesture(item));
    else if (item.type === 'end') voice.end();
  }

  function stopAll() {
    voice.stop();
    pointing = null;
    explainUntil = 0;
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
      body.target = M.wander(home, t);
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

    // Hovering the orb for a moment acknowledges a notification.
    if (attention && hoverSince && now - hoverSince > 700) acknowledge();
    // Informational colours fade on their own; warnings wait for you.
    if (attention && (attention.level === 'info' || attention.level === 'success') && now - attention.since > 12000) acknowledge();
  }

  function updateVisuals(dt, now) {
    const m = MODES[mode];
    let tint = m.tint;
    let glow = m.glow;
    let halo = 0;
    if (attention) {
      tint = ATTENTION[attention.level];
      glow = Math.max(glow, 0.55);
      halo = attention.level === 'urgent' ? 1 : 0.75;
    }
    const k = Math.min(1, dt * 4);
    for (let i = 0; i < 3; i++) vis.tint[i] += (tint[i] - vis.tint[i]) * k;
    vis.glow += (glow - vis.glow) * k;
    vis.halo += (halo - vis.halo) * k;
    vis.think += ((mode === 'thinking' ? 1 : 0) - vis.think) * k;
    vis.listen += ((mode === 'listening' ? Math.max(0.25, listenLevel) : 0) - vis.listen) * Math.min(1, dt * 12);
  }

  // ------------------------------------------------------------ loop

  let last = performance.now();
  let lastBoundsSent = 0;
  const t0 = last;

  // Is anything happening that needs full frame rate?
  function isActive() {
    return mode !== 'idle' || voice.speaking || !!pointing || !!explainUntil || body.dragging || !!attention
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
    M.step(body, dt);
    const amp = voice.update(dt, t);
    updateVisuals(dt, now);

    // A tiny shiver while speaking sells the "vibrating" voice.
    const jitter = amp * body.r * 0.025;
    const pos = {
      x: body.pos.x + (Math.sin(t * 61) + Math.sin(t * 37)) * 0.5 * jitter,
      y: body.pos.y + (Math.sin(t * 53 + 1) + Math.sin(t * 29)) * 0.5 * jitter,
    };
    const shown = { ...body, pos };
    const arms = body.arms.map((a) => (a.mode === 'off' && a.extend < 0.02 ? null : M.armGeometry(shown, a, t)));
    const tailGap = Math.hypot(body.tail.x - body.pos.x, body.tail.y - body.pos.y);

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
    });

    placeCaption(local(pos));

    if (bridge && now - lastBoundsSent > 100) {
      bridge.orbBounds({ x: body.pos.x, y: body.pos.y, r: body.r });
      lastBoundsSent = now;
    }
    // The chat dock hangs under the orb's resting spot (and follows a drag).
    if (bridge && body.dragging && now - lastAnchorSent > 33) {
      bridge.orbAnchor({ x: body.pos.x, y: body.pos.y, r: body.r });
      lastAnchorSent = now;
    }
    requestAnimationFrame(frame);
  }

  // Grow the window when COre needs more room, shrink it when it's settled.
  function updateStage(now, pos, arms) {
    if (!bridge || now - lastStageReq < 80) return;
    const capShown = caption.classList.contains('show');
    const need = S.neededRect({
      pos,
      target: body.target,
      tail: body.tail,
      r: body.r,
      arms,
      point: pointing ? { x: pointing.x, y: pointing.y } : null,
      caption: capShown ? { w: caption.offsetWidth, h: caption.offsetHeight, above: dockVisible } : null,
    });
    const settled = !pointing && !explainUntil && !body.dragging && Math.hypot(body.vel.x, body.vel.y) < 20
      && body.arms.every((a) => a.extend < 0.02);
    const next = S.decide({ stage, need, view, r: body.r, now, settled, state: stageState });
    if (next) {
      lastStageReq = now;
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

  function setupPointer() {
    let down = null;
    const toView = (e) => ({ x: e.clientX + stage.x, y: e.clientY + stage.y });
    canvas.addEventListener('pointerdown', (e) => {
      const p = toView(e);
      const d = Math.hypot(p.x - body.pos.x, p.y - body.pos.y);
      if (d > body.r * 1.2) return;
      down = { x: p.x, y: p.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!down) return;
      const p = toView(e);
      if (!down.moved && Math.hypot(p.x - down.x, p.y - down.y) > 6) {
        down.moved = true;
        body.dragging = true;
        pointing = null;
        if (bridge) bridge.orbDrag(true);
      }
      if (down.moved) body.target = { x: p.x, y: p.y };
    });
    canvas.addEventListener('pointerup', () => {
      if (!down) return;
      if (down.moved) {
        body.dragging = false;
        home = { x: body.target.x, y: body.target.y };
        lastGestureAt = performance.now();
        if (bridge) { bridge.orbDrag(false); bridge.orbHome(home); bridge.orbAnchor({ ...home, r: body.r }); }
      } else {
        acknowledge();
        if (bridge) bridge.orbClick();
      }
      down = null;
    });
  }

  // ------------------------------------------------------------ boot

  function applyConfig(c) {
    if (!c) return;
    cfg = { ...cfg, ...c };
    const b = (cfg.orb && cfg.orb.backdrop) || 'auto';
    light = b === 'light' ? 1 : b === 'dark' ? 0 : (cfg.lightTheme ? 1 : 0);
    voice.setConfig(cfg.voice);
    if (c.view) view = { ...c.view };
    if (c.stage) stage = { ...c.stage };
    if (body) {
      body.r = cfg.orb.radius || 60;
      if (c.view) placeHome();
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
      if (bridge) bridge.log(`renderer failed: ${err.message}`);
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
      bridge.onListenStart((meta) => { stopAll(); setMode('listening'); listener.start(meta); });
      bridge.onListenStop(() => listener.stop());
      bridge.onSpeechStop(stopAll);
      bridge.onHover((over) => { hoverSince = over ? performance.now() : 0; });
      bridge.onConfig(applyConfig);
      bridge.onDockVisible((v) => { dockVisible = !!v; });
      bridge.onStage((st) => { if (st) stage = { ...st }; });
      bridge.orbAnchor({ x: home.x, y: home.y, r: body.r });
    } else {
      demo();
    }
    requestAnimationFrame(frame);
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
    addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k === 'p') { voice.action(() => point(mouse.x, mouse.y)); voice.say('That spot, right there.'); voice.end(); }
      if (k === 'e') { voice.action(explain); voice.say('Here is the idea, in two parts.'); voice.end(); }
      if (k === 't') { voice.say("Hi, I'm COre. I live on your screen and I'm happy to help."); voice.end(); }
      if (k === 'l') setMode(mode === 'listening' ? 'idle' : 'listening');
      if (k === 'k') setMode(mode === 'thinking' ? 'idle' : 'thinking');
      if (k === 'n') { li = (li + 1) % (levels.length + 1); setAttention(li < levels.length ? { level: levels[li] } : null); }
      if (k === 'm') { home = { ...mouse }; lastGestureAt = 0; }
    });

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
      if (pose === 'move') { body.pos = { x: c.x - 260, y: c.y + 40 }; body.tail = { ...body.pos }; body.target = { x: c.x + 220, y: c.y - 20 }; lastGestureAt = performance.now() + 60000; }
    }
  }

  boot();
})();

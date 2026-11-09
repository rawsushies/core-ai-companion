'use strict';

const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen,
  desktopCapturer, shell, nativeImage, session, dialog, nativeTheme, safeStorage, Notification,
} = require('electron');
const { spawn } = require('child_process');

const { loadConfig, loadState } = require('./config');
const { Brain } = require('./brain');
const { SpeechToText } = require('./stt');
const { TextToSpeech, OrderedVoicePipeline } = require('./tts');
const { startNotifyServer } = require('./notifyServer');
const { Updater } = require('./updater');
const { Memory } = require('./memory');
const { Reminders } = require('./reminders');

const IS_LINUX = process.platform === 'linux';
const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PRELOAD = path.join(ROOT, 'src', 'preload');

// ---------------------------------------------------------------- graphics mode
// Transparent windows on Windows need working GPU compositing. If Chromium's
// GPU process crashes (or a driver is forced past Chromium's blocklist),
// Electron falls back to software compositing and transparent windows turn
// opaque black. So:
//   'auto' (default): normal GPU; if the GPU process crashes or compositing
//                     isn't available, restart once in safe graphics mode.
//   'software':       safe mode: software rendering from the start (keeps
//                     transparency), WebGL via SwiftShader, lighter orb.
//   'gpu':            force the GPU even on blocklisted drivers.
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
const EARLY_DIR = app.getPath('userData');
const earlyConfig = readJson(path.join(EARLY_DIR, 'config.json'));
const earlyState = readJson(path.join(EARLY_DIR, 'state.json'));
const GRAPHICS = (earlyConfig.orb && earlyConfig.orb.graphics) || 'auto';
const SAFE_GRAPHICS = GRAPHICS === 'software' || (GRAPHICS === 'auto' && earlyState.safeGraphics === true);
if (SAFE_GRAPHICS) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
} else if (GRAPHICS === 'gpu') {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}

// Transparent windows on Linux need these to composite correctly.
if (IS_LINUX) {
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

// Only one COre at a time; a second launch just brings the first one forward.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

// COre's windows only ever show their own local pages: no navigation, no popups.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e, url) => { if (url !== contents.getURL()) e.preventDefault(); });
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

let config; // JsonFile
let state;
let brain;
let stt;
let tts;
let updater;
let overlay = null;
let panel = null;
let dock = null;
let dockAnchor = null; // { x, y, r } orb resting spot, overlay coordinates
let dockVisible = true;
let dockHeight = 60;
let currentPipeline = null;
let memory = null;
let reminders = null;
const actions = new Map(); // one-click actions offered in the chat: id -> { kind, value }
// Spoken questions: the chat reveals each sentence as it is spoken, then the
// full formatted answer once COre stops talking. { spokenAny, finished, reply }
let syncTurn = null;
let ttsWarned = false;
let tray = null;
let current = null; // AbortController of the running turn
let listening = null; // { withScreen }
let orbBounds = { x: 0, y: 0, r: 60 };
let orbDragging = false;
let overlayInteractive = false;
let cursorWasNear = false;
let cursorTick = 0;
let cursorTimer = null;
let workDir;
const APP_STARTED = Date.now();
let lastShot = null;

const transcript = [];
const CLIPBOARD_RE = /(clipboard|what i('ve| have)? copied|i (just )?copied|the copied|(yang|tadi) (aku |saya |gue )?(copy|salin)|di clipboard)/i;
const DEIXIS = /(look at|see (this|that|my)|on (my|the) screen|what('?s| is) (this|that)\b|this (button|error|window|code|page|thing|message)|my screen|point (at|to)|where (is|do|should|can)|lihat (ini|itu|layar)|di layar|layar (saya|aku|gue)|yang ini|ini apa)/i;

// ---------------------------------------------------------------- helpers

const send = (win, channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};
const toOverlay = (c, p) => send(overlay, c, p);
const toPanel = (c, p) => send(panel, c, p);
const toDock = (c, p) => send(dock, c, p);

function addTranscript(role, text) {
  const entry = { role, text, ts: Date.now() };
  transcript.push(entry);
  if (transcript.length > 200) transcript.shift();
  state.set('transcript', transcript.slice(-100));
  toPanel('transcript:add', entry);
  // COre's own replies reach the dock as a live stream instead.
  if (role !== 'core') toDock('dock:message', { role: role === 'notice' ? 'system' : role, text });
}

function primaryDisplay() {
  return screen.getPrimaryDisplay();
}

function brainStatus() {
  try {
    return brain.describe();
  } catch {
    return { primary: 'not configured', fallback: null };
  }
}

// ---------------------------------------------------------------- secrets

// API keys are encrypted with the OS account (Windows DPAPI, macOS Keychain,
// libsecret on Linux) before they are written to config.json.
function getSecret(id) {
  const v = (config.data.brain.secrets || {})[id];
  if (!v) return '';
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('plain:')) return v.slice(6);
  } catch (err) {
    console.error(`[core] could not decrypt ${id} key: ${err.message}`);
  }
  return '';
}

function setSecret(id, value) {
  config.data.brain.secrets = config.data.brain.secrets || {};
  const key = String(value || '').trim();
  if (!key) delete config.data.brain.secrets[id];
  else if (safeStorage.isEncryptionAvailable()) config.data.brain.secrets[id] = `enc:${safeStorage.encryptString(key).toString('base64')}`;
  else config.data.brain.secrets[id] = `plain:${key}`;
  config.save();
}

function makeBrain() {
  return new Brain({
    config: config.data,
    workDir,
    state,
    getKey: getSecret,
    onModelChange: (id, model) => {
      const k = id === 'openai-compat' ? 'openaiCompat' : id;
      if (config.data.brain[k]) { config.data.brain[k].model = model; config.save(); }
    },
  });
}

// ---------------------------------------------------------------- brain status & login

const NAMES_FOR_UI = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter' };
const KEY_LINKS = {
  gemini: 'https://aistudio.google.com/apikey',
  groq: 'https://console.groq.com/keys',
  openrouter: 'https://openrouter.ai/keys',
  ollama: 'https://ollama.com/download',
};

async function brainStatusList() {
  if (!brain) return [];
  const out = [];
  for (const p of brain.chain) {
    if (p.id === 'claude-cli') {
      let st = 'checking';
      let detail = '';
      try {
        await p.detect();
        st = 'connected';
      } catch (err) {
        st = err.notLoggedIn ? 'login' : 'missing';
        detail = err.message;
      }
      out.push({ id: p.id, name: 'Claude', state: st, detail, model: p.cfg.model });
    } else if (p.id === 'ollama') {
      const pr = await p.probe();
      out.push({ id: p.id, name: 'Local model (Ollama)', state: !pr.running ? 'not-installed' : pr.hasModel ? 'connected' : 'no-model', model: p.cfg.model });
    } else if (p.id === 'openai-compat' && !p.cfg.baseUrl) {
      continue; // custom endpoint: only listed once it is configured in config.json
    } else {
      out.push({ id: p.id, name: p.name, state: p.available() ? 'connected' : 'no-key', model: p.cfg.model, keyable: p.id !== 'openai-compat' });
    }
  }
  return out;
}

let brainStatusCache = [];
async function refreshBrainStatus() {
  try {
    brainStatusCache = await brainStatusList();
  } catch (err) {
    console.error('[core] brain status failed:', err.message);
  }
  toDock('dock:brain', brainStatusCache);
  toPanel('status', { kind: 'brain', ...brainStatus() });
  return brainStatusCache;
}

// Keep a Claude Code process ready so the next message skips start-up time.
function warmClaude() {
  const c = brain && brain.provider('claude-cli');
  if (c && c.warm) c.warm((config.data.personality && config.data.personality.tone) || 'sarcastic');
}

function claudeCommand() {
  return (config.data.brain.claude && config.data.brain.claude.command) || 'claude';
}

// Open the official Claude Code sign-in (browser) in a terminal window, then
// watch for the login to complete.
let loginWatch = null;
function loginClaude() {
  const cmd = claudeCommand();
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/d', '/s', '/c', `start "Claude login" cmd /k ${cmd.includes(' ') ? `"${cmd}"` : cmd} auth login`], {
        windowsVerbatimArguments: true, detached: true, stdio: 'ignore',
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell application "Terminal" to do script "${cmd} auth login"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const term = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'];
      let launched = false;
      for (const t of term) {
        try {
          const args = t === 'gnome-terminal' ? ['--', cmd, 'auth', 'login'] : ['-e', `${cmd} auth login`];
          const child = spawn(t, args, { detached: true, stdio: 'ignore' });
          child.on('error', () => {});
          child.unref();
          launched = true;
          break;
        } catch {}
      }
      if (!launched) spawn(cmd, ['auth', 'login'], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (err) {
    addTranscript('system', `Could not open the Claude login: ${err.message}. Open a terminal and run: claude auth login`);
    return;
  }
  addTranscript('system', 'A Claude sign-in window opened. Finish the login in your browser; I will connect automatically.');
  const claude = brain && brain.provider('claude-cli');
  if (!claude) return;
  clearInterval(loginWatch);
  const started = Date.now();
  loginWatch = setInterval(async () => {
    if (Date.now() - started > 8 * 60_000) { clearInterval(loginWatch); return; }
    const st = await claude.authStatus().catch(() => ({ known: false }));
    if (st.known && st.loggedIn) {
      clearInterval(loginWatch);
      claude.flags = null;
      warmClaude();
      addTranscript('system', 'Claude is connected.');
      toOverlay('attention', { level: 'success', title: 'Claude connected' });
      refreshBrainStatus();
    }
  }, 3000);
}

// Install / pull the local Ollama model in the background.
async function setupLocalModel() {
  const o = brain && brain.provider('ollama');
  if (!o) return;
  const pr = await o.probe();
  if (!pr.running) {
    shell.openExternal(KEY_LINKS.ollama);
    addTranscript('system', 'Install Ollama from the page that just opened (free), start it, then press "Set up" again.');
    return;
  }
  addTranscript('system', `Downloading the local model ${o.cfg.model}… this can take a few minutes.`);
  try {
    const res = await fetch(`${o.cfg.baseUrl.replace(/\/$/, '')}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: o.cfg.model, stream: true }),
    });
    let lastPct = -10;
    const { readLines } = require('./brain/httpModels');
    for await (const line of readLines(res.body)) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.error) throw new Error(ev.error);
      if (ev.total && ev.completed) {
        const pct = Math.floor((ev.completed / ev.total) * 100);
        if (pct >= lastPct + 10) { lastPct = pct; toPanel('status', { kind: 'download', file: o.cfg.model, pct }); }
      }
    }
    addTranscript('system', `Local model ${o.cfg.model} is ready.`);
  } catch (err) {
    addTranscript('system', `Local model download failed: ${err.message}`);
  }
  refreshBrainStatus();
}

// ---------------------------------------------------------------- windows

// ---------------------------------------------------------------- stage
// The overlay window only covers the part of the screen COre needs ("stage",
// display coordinates). A full-screen transparent window makes Windows
// recomposite the whole desktop every frame, which lags the entire system.

let stage = null;

function viewSize() {
  const d = primaryDisplay();
  return { w: d.bounds.width, h: d.bounds.height };
}

function defaultHome() {
  const d = primaryDisplay();
  const r = config.data.orb.radius || 60;
  const wa = d.workArea;
  return { x: Math.round(wa.x - d.bounds.x + wa.width - r * 3.2), y: Math.round(wa.y - d.bounds.y + wa.height - r * 4.2) };
}

function homeNow() {
  const v = viewSize();
  const h = config.data.orb.home;
  return h && h.x > 0 && h.x < v.w && h.y > 0 && h.y < v.h ? h : defaultHome();
}

function clampStage(r) {
  const v = viewSize();
  const w = Math.max(64, Math.min(Math.round(r.w), v.w));
  const h = Math.max(64, Math.min(Math.round(r.h), v.h));
  return {
    x: Math.min(Math.max(Math.round(r.x), 0), v.w - w),
    y: Math.min(Math.max(Math.round(r.y), 0), v.h - h),
    w,
    h,
  };
}

function initialStage() {
  const r = config.data.orb.radius || 60;
  const home = homeNow();
  const half = Math.max(r * 3.6, 230);
  return clampStage({ x: home.x - half, y: home.y - half, w: half * 2, h: half * 2 });
}

function applyStage(next) {
  stage = clampStage(next);
  if (!overlay || overlay.isDestroyed()) return;
  const d = primaryDisplay();
  overlay.setBounds({ x: d.bounds.x + stage.x, y: d.bounds.y + stage.y, width: stage.w, height: stage.h });
  toOverlay('stage', stage);
}

function createOverlay() {
  const d = primaryDisplay();
  stage = initialStage();
  // Until the overlay reports, assume the orb sits at its home spot (so the
  // chat doesn't flash in the top-left corner on start).
  const r0 = config.data.orb.radius || 60;
  const h0 = homeNow();
  dockAnchor = { x: h0.x, y: h0.y, r: r0 };
  orbBounds = { x: h0.x, y: h0.y, r: r0 };
  overlay = new BrowserWindow({
    x: d.bounds.x + stage.x,
    y: d.bounds.y + stage.y,
    width: stage.w,
    height: stage.h,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    title: 'COre',
    webPreferences: {
      preload: path.join(PRELOAD, 'overlay.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  // No setContentProtection here: on some Windows/GPU combinations it makes a
  // transparent window render opaque black. Screenshots hide the orb instead.
  overlay.loadFile(path.join(RENDERER, 'overlay', 'index.html'));
  overlay.once('ready-to-show', () => overlay.showInactive());
  overlay.on('closed', () => { overlay = null; });

  // The overlay ignores the mouse except when the cursor is over the orb.
  // Polling the cursor works on every OS (Linux has no forwarded mouse moves).
  cursorTimer = setInterval(updateHitTest, 33);
}

function updateHitTest() {
  if (!overlay || overlay.isDestroyed() || !overlay.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const b = primaryDisplay().bounds; // orbBounds are display coordinates
  const dx = p.x - b.x - orbBounds.x;
  const dy = p.y - b.y - orbBounds.y;
  const over = orbDragging || Math.hypot(dx, dy) < orbBounds.r * 1.45; // the visible smoke, not just the core
  // Presence: tell the orb when the cursor is nearby so it can notice you.
  const near = Math.hypot(dx, dy) < orbBounds.r * 7;
  if (near || cursorWasNear) {
    if (++cursorTick % 3 === 0 || near !== cursorWasNear) toOverlay('cursor', near ? { x: p.x - b.x, y: p.y - b.y } : null);
    cursorWasNear = near;
  }
  if (over !== overlayInteractive) {
    overlayInteractive = over;
    overlay.setIgnoreMouseEvents(!over, { forward: true });
    toOverlay('hover', over);
  }
}

// ---------------------------------------------------------------- chat dock

const DOCK_WIDTH = 400;

function createDock() {
  dock = new BrowserWindow({
    width: DOCK_WIDTH,
    height: dockHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    title: 'COre chat',
    webPreferences: {
      preload: path.join(PRELOAD, 'dock.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  dock.setAlwaysOnTop(true, 'screen-saver');
  dock.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  dock.loadFile(path.join(RENDERER, 'dock', 'index.html'));
  dock.once('ready-to-show', () => { if (dockVisible) { positionDock(); dock.showInactive(); } });
  dock.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); setDockVisible(false); }
  });
}

// Hang the dock centred under the orb's resting spot; flip above it when
// there's no room below.
function positionDock() {
  if (!dock || dock.isDestroyed()) return;
  const d = primaryDisplay();
  const wa = d.workArea;
  const a = dockAnchor || { x: orbBounds.x, y: orbBounds.y, r: orbBounds.r };
  const ax = d.bounds.x + a.x;
  const ay = d.bounds.y + a.y;
  const gap = a.r * 1.45 + 8;
  let x = Math.round(ax - DOCK_WIDTH / 2);
  let y = Math.round(ay + gap);
  let side = 'below';
  if (y + dockHeight > wa.y + wa.height - 6) {
    y = Math.round(ay - gap - dockHeight);
    side = 'above';
  }
  x = Math.min(Math.max(x, wa.x + 6), wa.x + wa.width - DOCK_WIDTH - 6);
  y = Math.min(Math.max(y, wa.y + 6), wa.y + wa.height - dockHeight - 6);
  dock.setBounds({ x, y, width: DOCK_WIDTH, height: dockHeight });
  toOverlay('dock:visible', dockVisible && side === 'below');
}

function setDockVisible(v, focus = false) {
  if (v && orbHidden) toggleOrb();
  dockVisible = v;
  state.set('dockVisible', v);
  if (!dock) return;
  if (v) {
    positionDock(); // also tells the overlay which side the dock is on
    if (focus) { dock.show(); dock.focus(); toDock('dock:focus'); } else dock.showInactive();
  } else {
    dock.hide();
    toOverlay('dock:visible', false);
  }
}

function toggleDock() {
  if (!dock) return;
  if (dockVisible && dock.isVisible()) setDockVisible(false);
  else setDockVisible(true, true);
}

function dockSettings() {
  const v = config.data.voice;
  return {
    tone: (config.data.personality && config.data.personality.tone) || 'sarcastic',
    engine: v.engine,
    kokoroVoice: v.kokoroVoice,
    semitones: v.semitones,
    robot: v.robot,
    speakTyped: v.speakTyped !== false,
  };
}

// Settings the dock may change. Each validator returns the cleaned value, or
// undefined to reject it (0 and false are valid values).
const SETTINGS_KEYS = {
  'personality.tone': (v) => (['sarcastic', 'calm', 'cheerful', 'dramatic', 'professional'].includes(v) ? v : undefined),
  'voice.kokoroVoice': (v) => (/^[a-z]{2}_[a-z]+$|^system$/.test(String(v)) ? String(v) : undefined),
  'voice.semitones': (v) => (Number.isFinite(+v) ? Math.min(6, Math.max(-12, +v)) : undefined),
  'voice.robot': (v) => (Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : undefined),
  'voice.speakTyped': (v) => !!v,
};

function applySetting(key, value) {
  const check = SETTINGS_KEYS[key];
  if (!check) return;
  const v = check(value);
  if (v === undefined) return;
  if (key === 'voice.kokoroVoice') {
    if (v === 'system') config.data.voice.engine = 'system';
    else { config.data.voice.engine = 'kokoro'; config.data.voice.kokoroVoice = v; tts.warm(); }
  } else {
    const [group, name] = key.split('.');
    config.data[group] = config.data[group] || {};
    config.data[group][name] = v;
  }
  config.save();
  toOverlay('config', overlayConfig());
  toDock('dock:settings', dockSettings());
  if (key === 'personality.tone' && !current) warmClaude();
}

function createPanel() {
  panel = new BrowserWindow({
    width: 400,
    height: 560,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    minWidth: 320,
    minHeight: 360,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: 'COre',
    webPreferences: {
      preload: path.join(PRELOAD, 'panel.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  panel.loadFile(path.join(RENDERER, 'panel', 'index.html'));
  panel.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      panel.hide();
    }
  });
}

function placePanelNearOrb() {
  const d = primaryDisplay();
  const wa = d.workArea;
  const [w, h] = panel.getSize();
  const ox = d.bounds.x + orbBounds.x;
  const oy = d.bounds.y + orbBounds.y;
  let x = ox - w - orbBounds.r * 1.6;
  if (x < wa.x + 8) x = ox + orbBounds.r * 1.6;
  let y = oy - h / 2;
  x = Math.round(Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - w - 8));
  y = Math.round(Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - h - 8));
  panel.setPosition(x, y);
}

function togglePanel(force) {
  if (!panel) return;
  const show = force === undefined ? !panel.isVisible() : force;
  if (show) {
    placePanelNearOrb();
    panel.show();
    panel.focus();
    toPanel('focus-input');
  } else {
    panel.hide();
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('COre');
  const menu = Menu.buildFromTemplate([
    { label: 'Talk to COre', click: () => startListening(false) },
    { label: 'Talk about my screen', click: () => startListening(true) },
    { label: 'Show chat under the orb', click: () => setDockVisible(true, true) },
    { label: 'Conversation history', click: () => togglePanel(true) },
    { type: 'separator' },
    { label: 'Hide / show COre', click: toggleOrb },
    { label: 'New conversation', click: resetConversation },
    { label: 'Settings (config.json)', click: openConfig },
    { label: 'Check for updates', click: () => checkForUpdates(false) },
    { label: 'Log in to Claude', click: loginClaude },
    {
      label: 'Graphics',
      submenu: [
        { label: 'Automatic (recommended)', type: 'radio', checked: GRAPHICS === 'auto', click: () => setGraphicsMode('auto') },
        { label: 'Safe mode (fixes black boxes)', type: 'radio', checked: GRAPHICS === 'software', click: () => setGraphicsMode('software') },
        { label: 'Force GPU', type: 'radio', checked: GRAPHICS === 'gpu', click: () => setGraphicsMode('gpu') },
      ],
    },
    { label: 'Copy diagnostics', click: copyDiagnostics },
    { type: 'separator' },
    { label: 'Quit COre', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  // Clicking the tray icon brings COre back if hidden, otherwise opens the chat.
  tray.on('click', () => { if (orbHidden) toggleOrb(); else setDockVisible(true, true); });
}

let orbHidden = false;
function toggleOrb() {
  if (!overlay) return;
  orbHidden = !orbHidden;
  if (orbHidden) {
    // Dissolve into smoke first, then hide.
    toOverlay('dissolve');
    setTimeout(() => { if (orbHidden && overlay && !overlay.isDestroyed()) overlay.hide(); }, 650);
    if (dock && dock.isVisible()) dock.hide();
    const key = prettyKey(config.data.hotkeys.hide);
    // Make it obvious COre was hidden on purpose, and how to get it back.
    if (Notification.isSupported()) {
      new Notification({ title: 'COre is hidden', body: `Press ${key} (or use the tray icon) to bring COre back.`, silent: true }).show();
    }
    if (tray) tray.setToolTip(`COre (hidden — ${key} to show)`);
  } else {
    overlay.showInactive();
    toOverlay('assemble');
    if (dockVisible && dock) { positionDock(); dock.showInactive(); }
    if (tray) tray.setToolTip('COre');
  }
}

function openConfig() {
  shell.openPath(config.file);
  addTranscript('system', 'Opened config.json. Save it, then choose "Reload settings" in the panel.');
}

function reloadConfig() {
  config.reload();
  try {
    if (brain) for (const p of brain.chain) if (p.dispose) p.dispose();
    if (brain) brain.reload(config.data);
    else brain = makeBrain();
  } catch (err) {
    addTranscript('system', err.message);
  }
  stt.dispose();
  stt = makeStt();
  registerHotkeys();
  toOverlay('config', overlayConfig());
  toDock('dock:settings', dockSettings());
  toPanel('status', { kind: 'brain', ...brainStatus() });
  refreshBrainStatus().then(() => warmClaude());
  addTranscript('system', 'Settings reloaded.');
}

function overlayConfig() {
  const { orb, voice } = config.data;
  const orbCfg = SAFE_GRAPHICS
    ? { ...orb, particles: Math.min(orb.particles || 24000, 9000), renderScale: Math.min(orb.renderScale || 1, 0.8), idleFps: Math.min(orb.idleFps || 30, 24) }
    : orb;
  return {
    orb: orbCfg,
    voice: { ...voice, tts: voice.tts !== false },
    lightTheme: !nativeTheme.shouldUseDarkColors,
    view: viewSize(),
    stage,
    defaultHome: defaultHome(),
  };
}

// ---------------------------------------------------------------- screen

// Titles of every open window (minimised ones and other monitors included),
// so COre knows what's running even when it isn't visible in the picture.
async function openWindowTitles() {
  try {
    const wins = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    const seen = new Set();
    return wins.map((w) => String(w.name || '').trim())
      .filter((n) => n && !/^COre( chat)?$/.test(n) && !seen.has(n) && seen.add(n))
      .slice(0, 40)
      .map((n) => (n.length > 80 ? `${n.slice(0, 77)}…` : n));
  } catch {
    return [];
  }
}

async function captureScreen() {
  // Capture the monitor the mouse is on (where you're looking). COre can only
  // point on the monitor it lives on.
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const canPoint = d.id === primaryDisplay().id;
  const { width, height } = d.size;
  const scale = Math.min(1, 1568 / Math.max(width, height));
  const thumbnailSize = { width: Math.round(width * scale), height: Math.round(height * scale) };

  // Hide COre's own windows for a moment so they aren't in the screenshot.
  const toHide = config.data.orb.hideFromCaptures === false ? [] : [overlay, dock].filter((w) => w && !w.isDestroyed() && w.isVisible());
  for (const w of toHide) w.hide();
  if (toHide.length) await new Promise((r) => setTimeout(r, 160));
  let sources;
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  } finally {
    for (const w of toHide) w.showInactive();
  }
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
  if (!src) throw new Error('No screen available to capture.');
  const img = src.thumbnail;
  const size = img.getSize();
  if (!size.width) throw new Error('Screen capture returned an empty image (check screen recording permission).');
  // JPEG is several times smaller than PNG: faster to send, same for reading UI.
  const data = img.toJPEG(85);
  const windows = await openWindowTitles();

  const dir = path.join(workDir, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `shot-${Date.now()}.jpg`);
  fs.writeFileSync(file, data);
  // keep only the latest few screenshots
  const old = fs.readdirSync(dir).filter((f) => f.startsWith('shot-')).sort().slice(0, -5);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });

  return {
    path: file,
    width: size.width,
    height: size.height,
    base64: data.toString('base64'),
    mediaType: 'image/jpeg',
    displayWidth: width,
    displayHeight: height,
    canPoint,
    windows,
  };
}

function mapPoint(shot, x, y) {
  return {
    x: Math.round((x / shot.width) * shot.displayWidth),
    y: Math.round((y / shot.height) * shot.displayHeight),
  };
}

// ---------------------------------------------------------------- memory, reminders, actions

function fmtTime(ts) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
}

// Tags that act instead of animating. Returns true when handled here.
function handleActionTag(item) {
  if (item.name === 'remember') {
    if (!memory || config.data.memory.enabled === false) return true;
    const r = memory.remember(item.text);
    if (r && r.created) toDock('dock:message', { role: 'system', text: `🧠 Remembered: ${r.item.text}` });
    toDock('dock:memory', memory.list());
    return true;
  }
  if (item.name === 'forget') {
    const gone = memory && memory.forget(item.text);
    if (gone) toDock('dock:message', { role: 'system', text: `🧠 Forgot: ${gone.text}` });
    toDock('dock:memory', memory ? memory.list() : []);
    return true;
  }
  if (item.name === 'remind') {
    const r = reminders.add(item.when, item.text);
    toDock('dock:message', { role: 'system', text: r ? `⏰ Reminder at ${fmtTime(r.at)}: ${r.text}` : `⏰ I couldn't understand the time "${item.when}".` });
    toDock('dock:reminders', reminders.items);
    return true;
  }
  if (item.name === 'open' || item.name === 'copy') {
    const id = require('crypto').randomUUID();
    actions.set(id, { kind: item.name, value: item.name === 'open' ? item.url : item.text });
    // Keep only the most recent offers; old buttons simply stop working.
    while (actions.size > 30) actions.delete(actions.keys().next().value);
    let label;
    if (item.name === 'open') {
      let host = item.url;
      try { host = new URL(item.url).host; } catch {}
      label = `Open ${host}`;
    } else {
      label = `Copy “${item.text.length > 40 ? `${item.text.slice(0, 40)}…` : item.text}”`;
    }
    toDock('dock:action', { id, kind: item.name, label });
    return true;
  }
  return false;
}

// Runs only when the user clicks the button in the chat.
function runAction(id) {
  const a = actions.get(id);
  if (!a) return;
  actions.delete(id);
  if (a.kind === 'open' && /^https?:\/\//i.test(a.value)) shell.openExternal(a.value);
  if (a.kind === 'copy') Promise.resolve(require('electron').clipboard.writeText(a.value)).catch(() => {});
}

function onReminder(r, missed) {
  toOverlay('attention', { level: 'warn', title: 'Reminder' });
  addTranscript('notice', `⏰ ${missed ? `Missed while I was off (${fmtTime(r.at)}): ` : ''}${r.text}`);
  toDock('dock:reminders', reminders.items);
  if (Notification.isSupported()) new Notification({ title: 'COre reminder', body: r.text }).show();
  speakLine(missed ? `You missed a reminder while I was off: ${r.text}` : `Reminder: ${r.text}`);
}

// A short greeting on the first launch of the day. Built in, so it costs no
// Claude usage and works offline.
const GREETINGS = {
  sarcastic: {
    morning: ['Morning. I have been awake for exactly as long as you have.', 'Good morning. Coffee first, existential questions later.'],
    afternoon: ['Afternoon. Productive day so far, or are we pretending?', 'Oh, hello again. Shall we do something clever?'],
    evening: ['Evening. Still working? Bold.', 'Good evening. Let us make the most of the dark.'],
    night: ['Up late, I see. I will not judge. Much.', 'It is the middle of the night. Naturally, here we are.'],
  },
  dramatic: {
    morning: ['A new day dawns. I am ready.'], afternoon: ['The afternoon awaits our command.'],
    evening: ['Night falls, and I remain at your side.'], night: ['The world sleeps. We do not.'],
  },
  calm: {
    morning: ['Good morning. Take your time.'], afternoon: ['Good afternoon. I am here when you need me.'],
    evening: ['Good evening. How was your day?'], night: ['It is late. Be kind to yourself tonight.'],
  },
  cheerful: {
    morning: ['Good morning! Let us make today great!'], afternoon: ['Hey there! Hope your day is going well!'],
    evening: ['Good evening! What are we up to?'], night: ['Hi, night owl! What can I do for you?'],
  },
  professional: {
    morning: ['Good morning. Ready when you are.'], afternoon: ['Good afternoon. How can I help?'],
    evening: ['Good evening. How can I help?'], night: ['Good evening. How can I help?'],
  },
};

function greetIfFirstToday() {
  if (config.data.personality.greeting === false) return;
  const today = new Date().toDateString();
  if (state.get('lastGreet') === today) return;
  state.set('lastGreet', today);
  const h = new Date().getHours();
  const part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'night';
  const set = (GREETINGS[config.data.personality.tone] || GREETINGS.sarcastic)[part];
  speakLine(set[Math.floor(Math.random() * set.length)]);
}

// ---------------------------------------------------------------- turns

function abortCurrent() {
  if (current) {
    current.abort();
    current = null;
  }
  if (currentPipeline) {
    currentPipeline.cancel();
    currentPipeline = null;
  }
  // A finished spoken answer interrupted mid-speech still shows in full.
  toDock('dock:done', syncTurn && syncTurn.finished ? { text: syncTurn.reply } : {});
  syncTurn = null;
  toDock('dock:busy', false);
}

function makeVoicePipeline({ speak }) {
  const v = config.data.voice;
  // Until the voice model has loaded (first run downloads ~90 MB), speak with
  // the system voice instead of making every reply wait.
  const useKokoro = speak && v.tts !== false && v.engine !== 'system' && !tts.failed && tts.ready;
  if (speak && v.engine !== 'system' && !tts.ready && !tts.failed) tts.warm();
  return new OrderedVoicePipeline({
    synth: useKokoro ? (text) => tts.synth(text, { voice: v.kokoroVoice, semitones: v.semitones, speed: v.speed }) : null,
    forward: (item) => {
      if (item.type === 'say' && !speak) return;
      toOverlay('speak:item', item);
    },
    onError: (err) => {
      if (ttsWarned) return;
      ttsWarned = true;
      addTranscript('system', `COre's voice is not ready (${err.message}). Using your system voice for now.`);
    },
  });
}

function resetConversation() {
  abortCurrent();
  toOverlay('speech:stop');
  if (brain) brain.resetConversation();
  transcript.length = 0;
  state.set('transcript', []);
  toPanel('transcript:reset');
  toDock('dock:reset');
  addTranscript('system', 'Started a new conversation.');
  warmClaude();
}

// Say one line outside a conversation turn (errors, notifications, updates),
// with the same voice as normal replies.
function speakLine(text) {
  const p = makeVoicePipeline({ speak: true });
  p.push({ type: 'say', text });
  p.push({ type: 'end' });
}

async function handleUserText(text, { withScreen = false, typed = false } = {}) {
  text = String(text || '').trim();
  if (!text) return;
  abortCurrent();
  toOverlay('speech:stop');
  addTranscript('user', text);
  if (!brain) {
    addTranscript('system', 'No brain is configured. Open Settings and check brain.provider.');
    toOverlay('attention', { level: 'urgent', title: 'No brain configured' });
    return;
  }

  const share = withScreen || (config.data.screen.autoShareOnDeixis && DEIXIS.test(text));
  toOverlay('state', 'thinking');

  let shot = null;
  if (share) {
    try {
      shot = await captureScreen();
      lastShot = shot;
    } catch (err) {
      addTranscript('system', `Could not capture the screen: ${err.message}`);
    }
  }

  // Context for the model: relevant memories, and the clipboard when asked about it.
  // (Never let a context problem stop the message itself.)
  const contextBlocks = [];
  try {
    if (memory && config.data.memory.enabled !== false) {
      const mem = memory.contextFor(text);
      if (mem) contextBlocks.push(mem);
    }
    if (CLIPBOARD_RE.test(text)) {
      // Electron 45+: clipboard.readText() returns a Promise (older: a string).
      const clip = String((await Promise.resolve(require('electron').clipboard.readText())) || '').trim();
      contextBlocks.push(clip ? `[Clipboard]\n${clip.slice(0, 4000)}` : '[Clipboard] (empty)');
    }
  } catch (err) {
    console.error('[core] context failed:', err.message);
  }

  const ac = new AbortController();
  current = ac;
  const speak = !typed || config.data.voice.speakTyped !== false;
  const pipeline = makeVoicePipeline({ speak });
  currentPipeline = pipeline;
  const synced = speak && !typed && config.data.voice.tts !== false;
  const turnSync = synced ? { spokenAny: false, finished: false, reply: '' } : null;
  syncTurn = turnSync;
  toDock('dock:busy', true);
  toDock('dock:message', { role: 'core-start' });
  try {
    const { reply } = await brain.ask({
      text,
      shot,
      typed,
      context: contextBlocks.join('\n\n'),
      signal: ac.signal,
      onText: (t) => { if (!ac.signal.aborted && !turnSync) toDock('dock:delta', t); },
      onItem: (item) => {
        if (ac.signal.aborted) return;
        if (item.type === 'gesture' && item.name === 'point') {
          if (!shot || !shot.canPoint) return; // nothing real to point at on this monitor
          pipeline.push({ ...item, ...mapPoint(shot, item.x, item.y) });
          return;
        }
        if (item.type === 'gesture' && handleActionTag(item)) return;
        pipeline.push(item);
      },
      onStatus: (s) => {
        toPanel('status', s);
        if (s.kind === 'fallback') addTranscript('system', `${s.from} failed: ${s.reason} Switching to ${s.to}.`);
      },
    });
    if (reply) addTranscript('core', reply);
    if (turnSync && syncTurn === turnSync) {
      // Show the full answer when the voice finishes (or soon, if it never starts).
      turnSync.finished = true;
      turnSync.reply = reply;
      setTimeout(() => {
        if (syncTurn === turnSync && !turnSync.spokenAny) { toDock('dock:done', { text: reply }); syncTurn = null; }
      }, 4000);
      setTimeout(() => {
        if (syncTurn === turnSync) { toDock('dock:done', { text: reply }); syncTurn = null; }
      }, 90_000);
    } else {
      toDock('dock:done', { text: reply });
    }
  } catch (err) {
    toDock('dock:done', {});
    if (err.aborted) return;
    addTranscript('system', err.message);
    toOverlay('attention', { level: 'urgent', title: 'COre could not answer' });
    speakLine(/usage limit/i.test(err.message)
      ? "I've hit my Claude usage limit. Give me a free backup brain in the settings and I'll keep talking."
      : "I can't reach my brain right now. The chat says why.");
  } finally {
    if (current === ac) {
      current = null;
      toDock('dock:busy', false);
    }
  }
}

function startListening(withScreen) {
  if (listening) {
    toOverlay('listen:stop'); // second press: stop and send what we have
    return;
  }
  abortCurrent();
  toOverlay('speech:stop');
  listening = { withScreen };
  stt.warm();
  toOverlay('listen:start', { withScreen });
}

let sttNoticeShown = false;
function makeStt() {
  const v = config.data.voice;
  return new SpeechToText({
    model: v.sttModel,
    language: v.sttLanguage,
    cacheDir: path.join(app.getPath('userData'), 'models'),
    onProgress: (p) => {
      toPanel('status', { kind: 'download', file: p.file, pct: p.pct });
      // transformers.js reports progress even when reading its cache: only
      // announce a download when the model really isn't on disk yet.
      if (!sttNoticeShown && !fs.existsSync(path.join(app.getPath('userData'), 'models', ...v.sttModel.split('/')))) {
        sttNoticeShown = true;
        addTranscript('system', 'Downloading speech recognition (one time, about 80 MB). Your first request may take a minute.');
      }
    },
  });
}

// ---------------------------------------------------------------- hotkeys

function prettyKey(accel) {
  return String(accel || '').replace(/CommandOrControl|CmdOrCtrl/g, process.platform === 'darwin' ? '⌘' : 'Ctrl');
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = config.data.hotkeys;
  const bind = (accel, fn, name) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) addTranscript('system', `Hotkey ${prettyKey(accel)} (${name}) is taken by another app.`);
    } catch (err) {
      addTranscript('system', `Invalid hotkey ${prettyKey(accel)}: ${err.message}`);
    }
  };
  bind(hk.listen, () => startListening(false), 'talk');
  bind(hk.listenWithScreen, () => startListening(true), 'talk about screen');
  bind(hk.panel, () => toggleDock(), 'chat');
  bind(hk.hide, toggleOrb, 'hide orb');
}

// ---------------------------------------------------------------- IPC

function wireIpc() {
  const fromOverlay = (e) => overlay && e.sender === overlay.webContents;
  const fromPanel = (e) => panel && e.sender === panel.webContents;

  ipcMain.on('orb:bounds', (e, b) => {
    if (!fromOverlay(e) || !b) return;
    orbBounds = { x: +b.x || 0, y: +b.y || 0, r: Math.max(8, +b.r || 46) };
  });
  ipcMain.on('orb:drag', (e, dragging) => { if (fromOverlay(e)) orbDragging = !!dragging; });
  ipcMain.on('stage:need', (e, r) => {
    if (!fromOverlay(e) || !r || ![r.x, r.y, r.w, r.h].every(Number.isFinite)) return;
    applyStage(r);
  });
  ipcMain.on('orb:click', (e) => { if (fromOverlay(e)) toggleDock(); });
  ipcMain.on('orb:anchor', (e, a) => {
    if (!fromOverlay(e) || !a) return;
    dockAnchor = { x: +a.x || 0, y: +a.y || 0, r: Math.max(8, +a.r || 60) };
    if (dockVisible) positionDock();
  });

  const fromDock = (e) => dock && e.sender === dock.webContents;
  ipcMain.handle('dock:init', (e) => (fromDock(e) ? {
    settings: dockSettings(),
    // Recent conversation, plus notices from this session (the dock may load
    // after startup notices like "log in to Claude" were raised).
    recent: transcript.slice(-12)
      .filter((m) => m.role !== 'system' || m.ts >= APP_STARTED)
      .slice(-8)
      .map((m) => ({ role: m.role === 'notice' ? 'system' : m.role, text: m.text })),
  } : null));
  ipcMain.on('dock:ask', (e, text) => { if (fromDock(e)) handleUserText(text, { typed: true }); });
  ipcMain.on('dock:stop', (e) => { if (fromDock(e)) { abortCurrent(); toOverlay('speech:stop'); } });
  ipcMain.on('dock:listen', (e) => { if (fromDock(e)) startListening(false); });
  ipcMain.on('dock:openPanel', (e) => { if (fromDock(e)) togglePanel(true); });
  ipcMain.on('dock:hide', (e) => { if (fromDock(e)) setDockVisible(false); });
  ipcMain.on('dock:reset', (e) => { if (fromDock(e)) resetConversation(); });
  ipcMain.on('dock:resize', (e, h) => {
    if (!fromDock(e)) return;
    const nh = Math.round(Math.min(460, Math.max(48, +h || 60)));
    if (nh === dockHeight) return;
    dockHeight = nh;
    positionDock();
  });
  ipcMain.on('dock:setting', (e, { key, value } = {}) => { if (fromDock(e)) applySetting(key, value); });
  ipcMain.on('dock:checkUpdates', (e) => { if (fromDock(e)) checkForUpdates(false); });
  ipcMain.handle('dock:memory', (e) => (fromDock(e) && memory ? memory.list() : []));
  ipcMain.on('dock:memoryForget', (e, id) => { if (fromDock(e) && memory) { memory.forget(String(id)); toDock('dock:memory', memory.list()); } });
  ipcMain.on('dock:memoryClear', (e) => { if (fromDock(e) && memory) { memory.clear(); toDock('dock:memory', []); addTranscript('system', 'Memory cleared.'); } });
  ipcMain.handle('dock:reminders', (e) => (fromDock(e) && reminders ? reminders.items : []));
  ipcMain.on('dock:reminderCancel', (e, id) => { if (fromDock(e) && reminders) { reminders.cancel(String(id)); toDock('dock:reminders', reminders.items); } });
  ipcMain.on('dock:runAction', (e, id) => { if (fromDock(e)) runAction(String(id)); });
  ipcMain.handle('dock:brainStatus', (e) => (fromDock(e) ? refreshBrainStatus() : null));
  ipcMain.on('dock:loginClaude', (e) => { if (fromDock(e)) loginClaude(); });
  ipcMain.on('dock:setupLocal', (e) => { if (fromDock(e)) setupLocalModel(); });
  ipcMain.on('dock:setKey', (e, { id, key } = {}) => {
    if (!fromDock(e) || !['gemini', 'groq', 'openrouter'].includes(id)) return;
    setSecret(id, key);
    addTranscript('system', key ? `${NAMES_FOR_UI[id]} key saved (encrypted).` : `${NAMES_FOR_UI[id]} key removed.`);
    refreshBrainStatus();
  });
  ipcMain.on('dock:openLink', (e, id) => { if (fromDock(e) && KEY_LINKS[id]) shell.openExternal(KEY_LINKS[id]); });
  ipcMain.on('dock:diagnostics', (e) => { if (fromDock(e)) copyDiagnostics(); });
  ipcMain.on('dock:graphics', (e, mode) => { if (fromDock(e) && ['auto', 'software', 'gpu'].includes(mode)) setGraphicsMode(mode); });
  ipcMain.handle('dock:graphicsMode', (e) => (fromDock(e) ? { mode: GRAPHICS, safe: SAFE_GRAPHICS } : null));
  ipcMain.on('orb:home', (e, home) => {
    if (!fromOverlay(e) || !home || !Number.isFinite(home.x) || !Number.isFinite(home.y)) return;
    config.data.orb.home = { x: Math.round(home.x), y: Math.round(home.y) };
    config.save();
  });
  ipcMain.on('listen:audio', async (e, { audio, withScreen }) => {
    if (!fromOverlay(e)) return;
    listening = null;
    toOverlay('state', 'thinking');
    try {
      const pcm = audio instanceof Float32Array ? audio : new Float32Array(audio);
      const text = await stt.transcribe(pcm);
      if (!text) {
        toOverlay('state', 'idle');
        return;
      }
      await handleUserText(text, { withScreen });
    } catch (err) {
      addTranscript('system', `Speech recognition failed: ${err.message}. You can type in the chat panel instead.`);
      toOverlay('attention', { level: 'warn', title: 'Could not hear you' });
      toOverlay('state', 'idle');
    }
  });
  ipcMain.on('listen:cancelled', (e, reason) => {
    if (!fromOverlay(e)) return;
    listening = null;
    if (reason && reason !== 'silence') addTranscript('system', `Microphone: ${reason}`);
  });
  ipcMain.on('overlay:log', (e, msg) => { if (fromOverlay(e)) console.log('[overlay]', msg); });
  ipcMain.on('voice:spoken', (e, text) => {
    if (!fromOverlay(e) || !syncTurn) return;
    toDock('dock:delta', `${syncTurn.spokenAny ? ' ' : ''}${text}`);
    syncTurn.spokenAny = true;
  });
  ipcMain.on('voice:idle', (e) => {
    if (!fromOverlay(e) || !syncTurn || !syncTurn.finished) return;
    toDock('dock:done', { text: syncTurn.reply });
    syncTurn = null;
  });
  // The orb drew its first frame: graphics are fine, so now load the voice
  // (loading it earlier could collide with a safe-graphics restart).
  ipcMain.once('overlay:ready', (e) => {
    if (!fromOverlay(e)) return;
    // Spread start-up work out: loading the voice model uses every CPU core
    // for a moment, so do it a few seconds after COre has appeared.
    setTimeout(() => {
      if (config.data.voice.engine !== 'system' && config.data.voice.tts !== false) tts.warm();
    }, 6000);
    // Speech recognition loads lazily otherwise, which made the first spoken
    // question seconds slower. Warm it once the voice has loaded.
    setTimeout(() => { if (!listening) stt.warm(); }, 14000);
  });
  ipcMain.on('overlay:rendererFailed', (e, msg) => {
    if (!fromOverlay(e)) return;
    console.warn('[overlay] renderer failed:', msg);
    if (SAFE_GRAPHICS) addTranscript('system', `I can't draw my orb on this PC (${msg}). Try ⚙ → Display → Force GPU, or copy diagnostics and send them over.`);
    else switchToSafeGraphics(`WebGL unavailable: ${msg}`);
  });

  ipcMain.handle('overlay:init', (e) => (fromOverlay(e) ? overlayConfig() : null));
  ipcMain.handle('panel:init', (e) => {
    if (!fromPanel(e)) return null;
    const hk = config.data.hotkeys;
    return {
      transcript: transcript.slice(-100),
      brain: brainStatus(),
      hotkeys: { listen: prettyKey(hk.listen), listenWithScreen: prettyKey(hk.listenWithScreen), panel: prettyKey(hk.panel) },
      notify: { port: config.data.notify.port, enabled: config.data.notify.enabled },
    };
  });
  ipcMain.on('panel:ask', (e, { text, withScreen }) => { if (fromPanel(e)) handleUserText(text, { withScreen, typed: true }); });
  ipcMain.on('panel:reset', (e) => { if (fromPanel(e)) resetConversation(); });
  ipcMain.on('panel:openConfig', (e) => { if (fromPanel(e)) openConfig(); });
  ipcMain.on('panel:reload', (e) => { if (fromPanel(e)) reloadConfig(); });
  ipcMain.on('panel:hide', (e) => { if (fromPanel(e)) panel.hide(); });
  ipcMain.on('panel:stop', (e) => {
    if (!fromPanel(e)) return;
    abortCurrent();
    toOverlay('speech:stop');
  });
  ipcMain.on('panel:copyToken', (e) => {
    if (!fromPanel(e)) return;
    Promise.resolve(require('electron').clipboard.writeText(config.data.notify.token)).catch(() => {});
    addTranscript('system', 'Notification token copied to the clipboard.');
  });
}

// ---------------------------------------------------------------- notify

async function startNotify() {
  const n = config.data.notify;
  if (!n.enabled) return;
  try {
    await startNotifyServer({
      port: n.port,
      token: n.token,
      onNotify: (note) => {
        toOverlay('attention', { level: note.level, title: note.title });
        addTranscript('notice', note.body ? `${note.title} — ${note.body}` : note.title);
        if (note.speak || n.speak) speakLine(note.title);
      },
    });
  } catch (err) {
    addTranscript('system', `Notification endpoint could not start on port ${n.port}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- graphics watchdog

// Restart COre cleanly: stop the model threads and the Claude process first.
// Exiting while a native ONNX model is loading aborts the whole process.
let restarting = false;
async function restartApp() {
  if (restarting) return;
  restarting = true;
  app.isQuitting = true;
  try {
    if (brain) for (const p of brain.chain) if (p.dispose) p.dispose();
    await Promise.race([
      Promise.all([stt && stt.dispose(), tts && tts.dispose()]),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
  } catch {}
  if (state) state.flush();
  app.relaunch();
  app.exit(0);
}

function switchToSafeGraphics(reason) {
  if (SAFE_GRAPHICS || GRAPHICS !== 'auto' || state.get('safeGraphics')) return;
  console.warn(`[core] switching to safe graphics: ${reason}`);
  state.set('safeGraphics', true);
  state.set('safeGraphicsReason', reason);
  restartApp();
}

function watchGraphics() {
  // Chromium restarts its GPU process after transient crashes (sleep/wake,
  // driver updates). Only switch modes if compositing is really gone after.
  app.on('child-process-gone', (_e, d) => {
    if (d.type !== 'GPU' || d.reason === 'clean-exit') return;
    setTimeout(() => {
      const comp = String(app.getGPUFeatureStatus().gpu_compositing || '');
      if (process.platform === 'win32' && comp && !comp.startsWith('enabled')) switchToSafeGraphics(`GPU process ${d.reason}, compositing ${comp}`);
    }, 3000);
  });
  if (process.platform !== 'win32' || SAFE_GRAPHICS) return;
  setTimeout(() => {
    const st = app.getGPUFeatureStatus();
    const comp = String(st.gpu_compositing || '');
    if (comp && !comp.startsWith('enabled')) switchToSafeGraphics(`gpu_compositing=${comp}`);
  }, 4000);
}

async function diagnostics() {
  let gpu = null;
  try { gpu = await app.getGPUInfo('basic'); } catch {}
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: `${process.platform} ${require('os').release()}`,
    graphicsMode: SAFE_GRAPHICS ? 'safe (software)' : GRAPHICS,
    safeGraphicsReason: state.get('safeGraphicsReason') || null,
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    gpuDevices: gpu && gpu.gpuDevice ? gpu.gpuDevice.map((g) => ({ vendorId: g.vendorId, deviceId: g.deviceId, active: g.active, driver: g.driverVersion })) : null,
    displays: screen.getAllDisplays().map((d) => ({ size: d.size, scale: d.scaleFactor, primary: d.id === primaryDisplay().id })),
    stage,
    brain: brainStatusCache.map((b) => `${b.name}: ${b.state}`),
  };
}

async function copyDiagnostics() {
  const d = await diagnostics();
  await Promise.resolve(require('electron').clipboard.writeText(JSON.stringify(d, null, 2)));
  addTranscript('system', 'Diagnostics copied to the clipboard. Paste them to whoever is helping you.');
}

function setGraphicsMode(mode) {
  config.data.orb.graphics = mode;
  config.save();
  state.set('safeGraphics', false);
  restartApp();
}

// ---------------------------------------------------------------- updates

function relaunchAfterUpdate(version, needsInstall) {
  if (needsInstall) state.set('pendingInstall', true);
  state.flush();
  // Don't cut COre off mid-answer: wait (up to 3 minutes) until it's idle.
  const started = Date.now();
  const tryRestart = () => {
    if ((current || listening) && Date.now() - started < 180_000) {
      setTimeout(tryRestart, 2000);
      return;
    }
    toOverlay('attention', { level: 'info', title: 'COre updated' });
    speakLine(`Upgrade complete. Version ${version}. Try to contain your excitement.`);
    setTimeout(restartApp, 4500);
  };
  tryRestart();
}

async function checkForUpdates(quiet) {
  try {
    await updater.check({ quiet, onUpdated: relaunchAfterUpdate });
  } catch (err) {
    addTranscript('system', `Update failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------- app

app.on('second-instance', () => setDockVisible(true, true));

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  config = loadConfig(userData);
  state = loadState(userData);
  workDir = path.join(userData, 'claude-workspace');
  fs.mkdirSync(path.join(workDir, 'shots'), { recursive: true });
  transcript.push(...(state.get('transcript') || []));

  try {
    brain = makeBrain();
  } catch (err) {
    dialog.showErrorBox('COre', err.message);
  }
  updater = new Updater({
    appRoot: ROOT,
    getConfig: () => config.data.update,
    log: (msg) => addTranscript('system', msg),
  });
  if (state.get('pendingInstall')) {
    // Finish an update that changed packages, before anything native loads.
    try {
      await updater.installDependencies();
    } catch (err) {
      console.error('[core] post-update npm install failed:', err.message);
    }
    state.set('pendingInstall', false);
  }

  stt = makeStt();
  let voiceNoticeShown = false;
  tts = new TextToSpeech({
    cacheDir: path.join(userData, 'models'),
    quality: config.data.voice.quality,
    onProgress: (p) => {
      toPanel('status', { kind: 'download', file: `voice ${p.file}`, pct: p.pct });
      if (!voiceNoticeShown && !fs.existsSync(path.join(userData, 'models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX'))) {
        voiceNoticeShown = true;
        addTranscript('system', 'Downloading my voice (one time, about 90 MB). I will use your system voice until it is ready.');
      }
    },
  });
  dockVisible = state.get('dockVisible') !== false;
  memory = new Memory(path.join(userData, 'memory.json'));
  reminders = new Reminders({ store: state, onFire: onReminder });

  // Only COre's own overlay may use the microphone.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media' && overlay && wc === overlay.webContents);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => (
    permission === 'media' && !!overlay && wc === overlay.webContents
  ));

  wireIpc();
  watchGraphics();
  nativeTheme.on('updated', () => toOverlay('config', overlayConfig()));
  // Resolution, scaling or primary-monitor changes: refit the overlay.
  const refit = () => {
    if (!overlay || overlay.isDestroyed()) return;
    applyStage(stage || initialStage());
    toOverlay('config', overlayConfig());
    if (dockVisible) positionDock();
  };
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, refit);
  // Linux compositors sometimes need a beat before a transparent window is created.
  if (IS_LINUX) await new Promise((r) => setTimeout(r, 300));
  createOverlay();
  createPanel();
  createDock();
  createTray();
  registerHotkeys();
  await startNotify();
  updater.start(relaunchAfterUpdate);
  reminders.start();
  setTimeout(greetIfFirstToday, 3500);

  const hk = config.data.hotkeys;
  if (SAFE_GRAPHICS && GRAPHICS === 'auto' && !state.get('safeGraphicsAnnounced')) {
    state.set('safeGraphicsAnnounced', true);
    addTranscript('system', `Your graphics driver had trouble with transparent windows (${state.get('safeGraphicsReason') || 'GPU problem'}), so I switched to safe graphics mode. It keeps me transparent; the smoke is a little lighter.`);
  }
  if (!transcript.length) {
    addTranscript('system', `Hi, I'm COre. Press ${prettyKey(hk.listen)} to talk, ${prettyKey(hk.listenWithScreen)} to talk about your screen, or type in the chat under me. Brain: ${brainStatus().primary}.`);
  }

  await new Promise((r) => setTimeout(r, 1500)); // let the orb appear first
  refreshBrainStatus().then((list) => {
    const claude = list.find((p) => p.id === 'claude-cli');
    if (claude && claude.state === 'connected') setTimeout(warmClaude, 1500);
    const others = list.filter((p) => p.id !== 'claude-cli' && p.state === 'connected');
    if (claude && claude.state !== 'connected') {
      addTranscript('system', `${claude.detail}${others.length ? ` Until then I will use ${others.map((p) => p.name).join(', ')}.` : ' Press "Log in to Claude" in the chat, or connect a free alternative in ⚙ → Brain.'}`);
      toOverlay('attention', { level: 'warn', title: 'Connect a brain' });
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearInterval(cursorTimer);
  if (!restarting) {
    if (stt) stt.dispose();
    if (tts) tts.dispose();
  }
  if (updater) updater.stop();
  if (reminders) reminders.stop();
  if (brain) for (const p of brain.chain) if (p.dispose) p.dispose();
  if (state) state.flush();
});

app.on('window-all-closed', (e) => e.preventDefault());

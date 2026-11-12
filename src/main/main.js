'use strict';

const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, powerMonitor,
  desktopCapturer, shell, nativeImage, session, dialog, nativeTheme, safeStorage, Notification,
} = require('electron');
const { spawn } = require('child_process');

const { loadConfig, loadState } = require('./config');
const { Brain } = require('./brain');
const { SpeechToText } = require('./stt');
const { TextToSpeech, OrderedVoicePipeline } = require('./tts');
const { startNotifyServer } = require('./notifyServer');
const { Updater, depsChanged } = require('./updater');
const { ReleaseUpdater } = require('./releaseUpdater');
const { Memory } = require('./memory');
const { Reminders } = require('./reminders');
const SCHEMA = require('./settingsSchema');
const { Presence, chitchatPrompt } = require('./presence');
const CL = require('./clones');
const CORES = require('./cores');
const { matchWake } = require('./handsfree');
const { ScreenWatch } = require('./watch');
const { refinePoint } = require('./pointing');
const SK = require('./skills');
const { ProjectTools } = require('./tools');
const { ChangeManager, extractProposals } = require('./changes');
const { toneKey } = require('./brain/persona');
const { CrashLog } = require('./crashlog');
const { smokeTarget, SmokeTest } = require('./smoke');
const SMOKE = smokeTarget(); // CI / release self-test (see smoke.js)
let smoke = null;

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

// Local crash log (never uploaded). Uncaught errors are recorded instead of
// taking COre down with a dialog.
const crashLog = new CrashLog(path.join(EARLY_DIR, 'logs'));
// The first one in a session is mentioned in the chat (once), so problems
// aren't silent; repeated errors also tint the orb.
const mainErrors = [];
function onMainError(kind, err) {
  console.error(`[core] ${kind}:`, err);
  crashLog.record(kind, err);
  const now = Date.now();
  mainErrors.push(now);
  while (mainErrors.length && now - mainErrors[0] > 60_000) mainErrors.shift();
  try {
    if (!onMainError.told && typeof addTranscript === 'function' && config) {
      onMainError.told = true;
      addTranscript('system', 'Something went wrong inside me. It is written to the crash log (Settings → Maintenance → Open crash logs). If I start acting strange, restart me from the tray.');
    }
    if (mainErrors.length >= 5) toOverlay('attention', { level: 'warn', title: 'COre is having trouble' });
  } catch {}
}
process.on('uncaughtException', (err) => onMainError('main-exception', err));
process.on('unhandledRejection', (err) => onMainError('main-rejection', err));
app.on('render-process-gone', (_e, wc, d) => crashLog.record('renderer-gone', `${wc.getURL().split('/').slice(-2).join('/')} ${d.reason} (${d.exitCode})`));
app.on('child-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') crashLog.record('process-gone', `${d.type} ${d.reason} (${d.exitCode})`); });

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
let presence = null;
const clones = new Map(); // id -> helper clone
let cloneSeq = 0;
let mainSpeaking = false; // the main orb has sentences queued or playing
let mainSpeakingSince = 0;
let timingTurnStart = 0; // CORE_DEBUG latency measurement
let floor = null;
let lastReaction = 0;
let notes = null;
let plugins = [];
const PB = require('./playbooks');
let playbooks = [];
let playbookScheduler = null;
const playbookDir = () => path.join(app.getPath('userData'), 'skills');
const playbooksOn = () => config.data.skills.playbooks !== false;
let turnSkills = null;
let turnVia = 'chat'; // where the current turn came from (memory provenance) // skill lookups started during the current turn
let followUpPending = false; // conversation mode: listen again when this spoken reply ends
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

// One timeline for everything (Meiosis): meta.author is who wrote it
// ('prime' | 'scout' | 'forge' | 'sentinel'; entries from older versions have
// none and read as Prime), meta.kind is message/progress/tool/error/permission,
// meta.to lists the cores a user message was addressed to.
let transcriptSeq = 0; // cursor for the phone companion
function addTranscript(role, text, meta = {}) {
  const entry = { role, text, ts: Date.now(), ...meta, seq: ++transcriptSeq };
  transcript.push(entry);
  if (transcript.length > 200) transcript.shift();
  state.set('transcript', transcript.slice(-100));
  toPanel('transcript:add', entry);
  // Prime's own replies reach the dock as a live stream instead.
  if (role !== 'core' || (meta.author && meta.author !== 'prime')) {
    toDock('dock:message', { role: role === 'notice' ? 'system' : role, text, author: meta.author, kind: meta.kind, to: meta.to, files: meta.files });
  }
}

// The display COre lives on (follows you to the monitor you use when
// orb.followDisplay is on). Named for history: it used to be the primary one.
let orbDisplayId = null;
function primaryDisplay() {
  if (orbDisplayId !== null) {
    const d = screen.getAllDisplays().find((x) => x.id === orbDisplayId);
    if (d) return d;
    orbDisplayId = null;
  }
  return screen.getPrimaryDisplay();
}

// Summoned from another monitor: reassemble on that one.
function followCursorDisplay() {
  if (config.data.orb.followDisplay === false || !overlay || overlay.isDestroyed()) return false;
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (d.id === primaryDisplay().id) return false;
  orbDisplayId = d.id;
  stage = null;
  applyStage(initialStage());
  const cfg = overlayConfig();
  toOverlay('config', cfg);
  const h = config.data.orb.home;
  const home = h && h.x > 0 && h.y > 0 && h.x < d.size.width && h.y < d.size.height ? h : defaultHome();
  toOverlay('relocate', home);
  orbBounds = { ...orbBounds, x: home.x, y: home.y };
  dockAnchor = { x: home.x, y: home.y, r: orbBounds.r };
  if (dockVisible) positionDock();
  return true;
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
  try { brainRouter.clear(id); } catch {} // a new key: try that brain again right away
}

// One router for every brain (Prime, the agent, the specialists): a provider
// that is rate limited or down is skipped by all of them at once.
const { Router: BrainRouter } = require('./brain/router');
const brainRouter = new BrainRouter();
const { Decider } = require('./brain/decide');
const decider = new Decider({ cfg: () => (config && config.data.brain && config.data.brain.jev) || {}, getKey: (id) => getSecret(id) });

function makeBrain() {
  return new Brain({
    router: brainRouter,
    decider,
    profile: 'chat',
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
        if ((brainRouter.h['claude-cli'] || {}).kind === 'auth') brainRouter.clear('claude-cli'); // logged in now
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
  const pc = config.data.personality || {};
  if (c && c.warm) c.warm(toneKey(pc.tone || 'sarcastic', pc.language));
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
  const half = Math.max(Math.round(r * 7.4), 440) / 2; // same square the overlay uses
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
  if (clones.size) cloneHitTest(p);
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

const DOCK_WIDTH = 320; // compact, flat chat (brand: minimal)

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
    largeText: !!(config.data.a11y && config.data.a11y.largeText),
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
  if (key.startsWith('voice.')) schedulePrewarm();
}

// ---------------------------------------------------------------- settings window

let settingsWin = null;

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 780,
    height: 580,
    minWidth: 620,
    minHeight: 440,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    title: 'COre settings',
    icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(PRELOAD, 'settings.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.loadFile(path.join(RENDERER, 'settings', 'index.html'));
  settingsWin.once('ready-to-show', () => { settingsWin.center(); settingsWin.show(); });
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------------------------------------------------------------- command center
// One window for everything COre is doing: the agent task, cores, shared tasks,
// workflows, memory health, playbooks, devices, files and the audit log, with
// the emergency stop always in reach.
let centerWin = null;
function openCommandCenter() {
  if (centerWin && !centerWin.isDestroyed()) { centerWin.show(); centerWin.focus(); return; }
  centerWin = new BrowserWindow({
    width: 960, height: 680, minWidth: 640, minHeight: 460, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    title: 'COre command center', icon: path.join(ROOT, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(PRELOAD, 'command.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  centerWin.loadFile(path.join(RENDERER, 'command', 'index.html'));
  centerWin.once('ready-to-show', () => { centerWin.center(); centerWin.show(); });
  centerWin.on('closed', () => { centerWin = null; });
}

function readAudit(n = 80) {
  try {
    const f = path.join(app.getPath('userData'), 'logs', 'tools.log');
    const st = fs.statSync(f);
    const len = Math.min(st.size, 96 * 1024);
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').filter((l) => l.startsWith('{')).slice(-n).reverse().map((l) => {
      try {
        const { at, ...rest } = JSON.parse(l);
        const what = rest.event || rest.guard || rest.skill || rest.tool || Object.keys(rest)[0] || 'entry';
        const detail = Object.entries(rest).filter(([k]) => k !== 'event').map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
        return { at, what: String(what).slice(0, 160), detail: detail.slice(0, 400) };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function centerState() {
  const t = readAgentTask();
  let changed = 0;
  try { if (t && t.taskId) changed = agentFiles().changed(t.taskId).length; } catch {}
  const shelfItems = shelf || fs.existsSync(path.join(app.getPath('userData'), 'files')) ? fileShelf().list() : [];
  const phone = config.data.phone || {};
  return {
    version: app.getVersion(),
    brain: brainStatus(),
    route: brain ? { ...brain.routeStatus(), jev: decider.status() } : null,
    agent: { enabled: !!(config.data.agent || {}).enabled, running: !!(agentRunner && agentRunner.running), task: t ? { goal: String(t.goal || ''), step: t.step, status: t.status, at: t.at, changed } : null },
    cores: cores.map((c) => { const h = clones.get(c.id); return { id: c.id, name: c.name, role: c.role, color: c.color, active: c.id === 'prime' || !!h, busy: h ? h.busy : 0 }; }),
    tasks: (state.get('tasks') || []).slice(-8).reverse().map((k) => ({ id: k.id, text: String(k.text || '').slice(0, 200), status: k.status, at: k.createdAt, steps: (k.steps || []).map((x) => ({ core: (coreById(x.core) || { name: x.core }).name, status: x.status })) })),
    workflows: playbookScheduler ? playbookScheduler.upcoming() : [],
    playbooks: playbooks.map((p) => ({ name: p.name, description: p.description, core: (coreById(p.core) || { name: 'COre' }).name, schedule: p.schedule, enabled: p.enabled })),
    playbooksOn: playbooksOn(),
    memory: memory ? { ...memory.stats(), enabled: config.data.memory.enabled !== false, recent: memory.conflicts.slice(0, 6).map((c) => ({ was: c.was, now: c.now, at: c.at })) } : null,
    files: { total: shelfItems.length, ready: shelfItems.filter((f) => f.status === 'ready').length, errors: shelfItems.filter((f) => f.status === 'error').length, recent: shelfItems.slice(0, 5).map((f) => ({ name: f.name, kind: f.kind, info: f.info, status: f.status })) },
    devices: {
      phone: { enabled: !!phone.enabled, paired: companion ? companion.list().length : (state.get('phoneDevices') || []).length },
      drive: { connected: !!getSecret('googleRefresh'), syncedAt: state.get('driveSyncedAt') || 0 },
      backup: { folder: !!(config.data.backup && config.data.backup.folder), last: state.get('lastBackup') || '' },
    },
    audit: readAudit(),
  };
}

async function centerAction(name, arg) {
  switch (name) {
    case 'emergency': emergencyStop('you pressed Emergency stop in the command center'); return { ok: true };
    case 'agentResume': startAgent('resume'); return { ok: true };
    case 'agentUndo': undoAgentTask(); return { ok: true };
    case 'agentStop': stopAgent('you pressed Stop in the command center'); return { ok: true };
    case 'runWorkflow': { const s = playbooks.find((p) => p.name === String(arg)); if (!s) return { ok: false, error: 'No such playbook.' }; runWorkflow(s); return { ok: true }; }
    case 'consolidate': { if (!memory) return { ok: false }; const r = memory.consolidate(); toDock('dock:memory', memory.list()); return { ok: true, message: `Merged ${r.merged}, retired ${r.retired}; ${r.total} memories.` }; }
    case 'openSkills': fs.mkdirSync(playbookDir(), { recursive: true }); shell.openPath(playbookDir()); return { ok: true };
    case 'openLogs': { const d = path.join(app.getPath('userData'), 'logs'); fs.mkdirSync(d, { recursive: true }); shell.openPath(d); return { ok: true }; }
    case 'openSettings': openSettings(); return { ok: true };
    case 'openChat': setDockVisible(true, true); return { ok: true };
    default: return { ok: false, error: 'unknown action' };
  }
}

// Only the values the window shows: never secrets.
function settingsValues() {
  const out = {};
  for (const key of SCHEMA.FIELDS.keys()) {
    let v = SCHEMA.getPath(config.data, key);
    if (key === 'app.startWithWindows') v = startsWithWindows();
    if (SCHEMA.FIELDS.get(key).secret) v = ''; // secrets never go back to a window
    SCHEMA.setPath(out, key, v);
  }
  return out;
}

// Which secret settings have a value saved (shown as "saved", never revealed).
function settingsSecrets() {
  const out = {};
  for (const [key, f] of SCHEMA.FIELDS) if (f.secret) out[key] = !!getSecret(f.secret);
  return out;
}

function startsWithWindows() {
  if (!['win32', 'darwin'].includes(process.platform)) return !!(config.data.app && config.data.app.startWithWindows);
  try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
}

function setStartWithWindows(on) {
  if (!['win32', 'darwin'].includes(process.platform)) return;
  // Source installs launch through electron.exe + the app folder.
  const args = app.isPackaged ? [] : [ROOT];
  try { app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args }); } catch (err) { console.warn('[core] login item:', err.message); }
}

// Performance profiles: one choice sets the smoke's cost.
const PROFILES = {
  battery: { particles: 8000, renderScale: 0.65, idleFps: 10, maxFps: 30, lite: true },
  balanced: { particles: 20000, renderScale: 0.9, idleFps: 20, maxFps: 0, lite: false },
  quality: { particles: 40000, renderScale: 1, idleFps: 45, maxFps: 0, lite: false },
};

// Apply one validated change right away where that's possible.
function applyLive(key, value) {
  if (key === 'phone.enabled') syncPhone();
  if (key === 'app.startWithWindows') setStartWithWindows(value);
  if (key === 'orb.profile' && PROFILES[value]) { Object.assign(config.data.orb, PROFILES[value]); config.save(); }
  if (key.startsWith('a11y.')) { toOverlay('config', overlayConfig()); toDock('dock:settings', dockSettings()); }
  if (key.startsWith('hotkeys.')) registerHotkeys();
  if (key.startsWith('voice.') || key.startsWith('orb.')) toOverlay('config', overlayConfig());
  if (key === 'voice.wakeWord') { if (value) stt.warm(); if (tray) { createTrayMenu(); trayTooltip(); } }
  if (key === 'voice.kokoroVoice' || key === 'voice.engine') { if (config.data.voice.engine === 'kokoro') tts.warm(); }
  if (['voice.kokoroVoice', 'voice.engine', 'voice.semitones', 'voice.speed', 'voice.tts'].includes(key)) schedulePrewarm();
  if (key.startsWith('brain.')) {
    try {
      if (brain) for (const p of brain.chain) if (p.dispose) p.dispose();
      if (brain) brain.reload(config.data); else brain = makeBrain();
      // New brain settings: give every brain a fresh chance.
      for (const id of Object.keys(brainRouter.h)) brainRouter.clear(id);
      // The agent and idle specialists pick up the new model on their next turn.
      if (agentBrainInst && !(agentRunner && agentRunner.running)) { for (const p of agentBrainInst.chain) if (p.dispose) p.dispose(); agentBrainInst = null; }
      for (const c of clones.values()) if (!c.busy) disposeHelperBrain(c);
    } catch (err) { addTranscript('system', err.message); }
    refreshBrainStatus().then(() => warmClaude());
  }
  if (key === 'personality.tone' && !current) warmClaude();
  toDock('dock:settings', dockSettings());
}

function changeSetting(key, value) {
  const v = SCHEMA.validate(key, value);
  if (v === undefined) return { ok: false, error: 'That value is not allowed.' };
  if (key.startsWith('hotkeys.')) {
    const clash = Object.entries(config.data.hotkeys).find(([k, acc]) => `hotkeys.${k}` !== key && acc === v);
    if (clash) return { ok: false, error: 'Another COre shortcut already uses that key.' };
  }
  const field = SCHEMA.FIELDS.get(key);
  if (field.secret) {
    setSecret(field.secret, v); // encrypted; the plain value is never written to config
    SCHEMA.setPath(config.data, key, '');
    config.save();
    return { ok: true, values: settingsValues(), secrets: settingsSecrets() };
  }
  SCHEMA.setPath(config.data, key, v);
  config.save();
  applyLive(key, v);
  return { ok: true, values: settingsValues(), secrets: settingsSecrets() };
}

function removeUserData(names) {
  const dir = app.getPath('userData');
  for (const n of names) {
    try { fs.rmSync(path.join(dir, n), { recursive: true, force: true }); } catch {}
  }
}

function toSettings(channel, payload) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- phone companion
// Off by default. See companion.js and docs/dev/PHONE.md for the security model.
const { Companion } = require('./companion');
let companion = null;

function loadPhoneDevices() {
  const out = [];
  for (const d of state.get('phoneDevices') || []) {
    try {
      const raw = String(d.key || '');
      const k = raw.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64')) : raw.startsWith('plain:') ? raw.slice(6) : '';
      const key = new Uint8Array(Buffer.from(k, 'base64'));
      if (key.length === 32) out.push({ ...d, key });
    } catch {}
  }
  return out;
}

function savePhoneDevices(list) {
  state.set('phoneDevices', list.map((d) => {
    const k = Buffer.from(d.key).toString('base64');
    const key = safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(k).toString('base64')}` : `plain:${k}`;
    return { id: d.id, name: d.name, key, ctr: d.ctr, created: d.created, lastSeen: d.lastSeen };
  }));
}

function phoneFeed(since) {
  const events = transcript.filter((e) => e.seq > since && e.role !== 'system' && e.text).slice(-50).map((e) => {
    const c = e.author ? coreById(e.author) : null;
    return { seq: e.seq, role: e.role, text: String(e.text).slice(0, 8000), author: e.author, name: c && c.name, color: c && c.color };
  });
  return { events, status: { busy: !!current, speaking: mainSpeaking } };
}

function ensureCompanion() {
  if (companion) return companion;
  companion = new Companion({
    port: Number.isInteger(config.data.phone.port) ? config.data.phone.port : 47330, // 0 = any free port (tests)
    host: /^[\w.:-]{3,60}$/.test(config.data.phone.host || '') ? config.data.phone.host : '',
    staticDir: path.join(__dirname, '..', 'renderer', 'phone'),
    naclFile: require.resolve('tweetnacl/nacl-fast.min.js'),
    iconFile: path.join(ROOT, 'assets', 'brand', 'icon-128.png'),
    devices: loadPhoneDevices(),
    saveDevices: savePhoneDevices,
    confirmPair: async ({ name, code }) => {
      // End-to-end tests only (unpackaged dev runs): there is nobody to click Allow.
      if (process.env.CORE_E2E_PAIR_ALLOW === '1' && !app.isPackaged) { toSettings('settings:phone', { paired: name }); return true; }
      const parent = settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined;
      const r = await dialog.showMessageBox(parent, {
        type: 'question', buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1, noLink: true,
        title: 'Pair a phone', message: `Allow "${name}" to talk to COre?`,
        detail: `Allow only if your phone shows this code:\n\n${code}\n\nThe phone can read the chat, send messages and stop COre talking. You can remove it any time in Settings, Phone.`,
      });
      const ok = r.response === 0;
      if (ok) toSettings('settings:phone', { paired: name });
      return ok;
    },
    onMessage: (text, device) => { handleUserText(text, { typed: true, remote: true }); toolAudit(`phone ${device.name}: message`); },
    onStop: () => { abortCurrent(); toOverlay('speech:stop'); },
    onMedia: (action) => {
      if (config.data.skills.music === false) return;
      const cmd = SK.musicCommand(action, process.platform);
      if (cmd) require('child_process').execFile(cmd.file, cmd.args, { timeout: 6000, windowsHide: true }, () => {});
    },
    // The phone app keeps a copy of what COre knows about you for when it's away from the PC.
    getMemory: () => (config.data.memory && config.data.memory.enabled === false ? [] : (memory && memory.items ? memory.items : []).slice(-200).map((m) => ({ text: String(m.text || '').slice(0, 300) }))),
    getFeed: phoneFeed,
  });
  return companion;
}

async function syncPhone() {
  const on = config.data.phone && config.data.phone.enabled;
  if (on) {
    try { await ensureCompanion().start(); } catch (err) {
      addTranscript('system', `The phone companion could not start: ${err.code === 'EADDRINUSE' ? `port ${config.data.phone.port} is in use` : err.message}.`, { kind: 'error' });
    }
  } else if (companion) companion.stop();
}

function phoneQr(url) {
  const qr = require('qrcode-generator')(0, 'M');
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
}

// ---------------------------------------------------------------- memory intelligence
// Automatic capture from the user's own words, project history, semantic
// search (optional local model) and a daily consolidation pass.
let embedder = null;

function currentProject() {
  const root = config.data.tools && config.data.tools.projectRoot;
  return root ? path.basename(root).replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, 40) || null : null;
}

function autoCapture(text) {
  const m = config.data.memory || {};
  if (!memory || m.enabled === false || m.autoCapture === false) return;
  try {
    for (const r of memory.capture(text)) {
      if (r.created) toDock('dock:message', { role: 'system', text: `Remembered: ${r.item.text}` });
      else if (r.replaced) toDock('dock:message', { role: 'system', text: `Updated: ${r.item.text} (was: ${r.replaced})` });
    }
    toDock('dock:memory', memory.list());
    scheduleDriveSync();
  } catch {}
}

function noteEpisode(text) {
  if (!memory || (config.data.memory || {}).enabled === false) return;
  try { memory.noteEpisode(text, { project: currentProject() }); } catch {}
}

function startMemoryEngine() {
  if (!memory) return;
  if ((config.data.memory || {}).semantic !== false) {
    embedder = new Embedder({ cacheDir: path.join(app.getPath('userData'), 'models') });
    memory.setEmbedder((texts) => embedder.embed(texts));
  }
  const pass = () => { try { const r = memory.consolidate(); if (r.merged || r.retired) toDock('dock:memory', memory.list()); } catch {} };
  setTimeout(pass, 90_000);
  setInterval(pass, 24 * 3600_000).unref();
}

// ---------------------------------------------------------------- Google Drive memory (optional)
// See gdrive.js. Off until you add your OAuth client and connect.
const GD = require('./gdrive');
const GUARD = require('./guard');
const { Embedder } = require('./embed');
let drive = null;
let driveSyncTimer = null;
let driveSyncing = false;

function noteMemoryRemoved(text) {
  const list = (state.get('memoryRemoved') || []).filter((r) => Date.now() - r.at < 90 * 864e5).slice(-300);
  list.push({ text: String(text).slice(0, 300), at: Date.now() });
  state.set('memoryRemoved', list);
  scheduleDriveSync();
}

function googleDrive() {
  const c = config.data.cloud || {};
  if (!drive) {
    drive = new GD.GoogleDrive({
      clientId: c.googleClientId || '',
      clientSecret: getSecret('googleClientSecret'),
      refreshToken: getSecret('googleRefresh'),
      fetch: (u, o) => require('electron').net.fetch(u, o),
      openBrowser: (url) => shell.openExternal(url),
      saveRefreshToken: (t) => setSecret('googleRefresh', t),
    });
  }
  return drive;
}

function scheduleDriveSync(ms = 30000) {
  if (!(config.data.cloud && config.data.cloud.autoSync !== false) || !getSecret('googleRefresh')) return;
  clearTimeout(driveSyncTimer);
  driveSyncTimer = setTimeout(() => syncDrive().catch(() => {}), ms);
}

async function syncDrive() {
  if (driveSyncing || !memory) return { ok: false, error: 'busy' };
  driveSyncing = true;
  try {
    const d = googleDrive();
    const cloud = await d.read();
    const local = { items: memory.items.map((i) => ({ text: i.text, at: i.updatedAt || i.ts || 0 })), removed: state.get('memoryRemoved') || [] };
    const merged = GD.mergeMemory(local, cloud);
    const have = new Set(memory.items.map((i) => i.text.toLowerCase().replace(/\s+/g, ' ').trim()));
    let added = 0;
    for (const it of merged.items) if (!have.has(it.text.toLowerCase().replace(/\s+/g, ' ').trim())) { if (memory.remember(it.text, { source: { via: 'cloud' } })) added++; }
    let dropped = 0;
    for (const r of merged.removed) {
      const hit = memory.items.find((i) => i.text.toLowerCase().replace(/\s+/g, ' ').trim() === r.text && (i.updatedAt || i.ts || 0) <= r.at);
      if (hit && memory.forget(hit.id)) dropped++;
    }
    await d.write(merged);
    state.set('memoryRemoved', merged.removed);
    state.set('driveSyncedAt', Date.now());
    if (added || dropped) toDock('dock:memory', memory.list());
    return { ok: true, added, dropped, total: merged.items.length };
  } finally {
    driveSyncing = false;
  }
}

// ---------------------------------------------------------------- backups
const BK = require('./backup');

function flushData() {
  try { config.save(); } catch {}
  try { state.flush(); } catch {}
}

function runBackup(kind) {
  const b = config.data.backup || {};
  if (!b.folder) return { ok: false, error: 'Choose a backup folder first (Settings, Backup).' };
  try {
    flushData();
    const r = BK.createBackup({ dataDir: app.getPath('userData'), destDir: b.folder, passphrase: getSecret('backup'), appVersion: app.getVersion(), keep: b.keep || 10 });
    state.set('lastBackup', new Date().toISOString());
    return { ok: true, ...r };
  } catch (err) {
    if (kind === 'auto') console.error(`[core] automatic backup failed: ${err.message}`);
    return { ok: false, error: `Backup failed: ${err.message}` };
  }
}

// Automatic backups: checked at start and every hour; cheap when not due.
function checkAutoBackup() {
  const b = config.data.backup || {};
  if (b.folder && BK.isDue(state.get('lastBackup'), Number(b.auto) || 0)) runBackup('auto');
}

async function settingsAction(name) {
  switch (name) {
    case 'update':
      checkForUpdates(false);
      return { message: 'Checking for updates…' };
    case 'diagnostics':
      await copyDiagnostics();
      return { message: 'Diagnostics copied to the clipboard.' };
    case 'pickProjectFolder': {
      const r = await dialog.showOpenDialog(settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined, { title: 'Share a project folder with COre (read-only)', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return { message: 'Nothing changed.' };
      const res = changeSetting('tools.projectRoot', r.filePaths[0]);
      return { message: res.ok ? `COre can now read ${path.basename(r.filePaths[0])} (never change it).` : res.error, values: res.values, secrets: res.secrets };
    }
    case 'pickBackupFolder': {
      const r = await dialog.showOpenDialog(settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined, { title: 'Where should COre keep its backups?', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return { message: 'Nothing changed.' };
      const res = changeSetting('backup.folder', r.filePaths[0]);
      return { message: res.ok ? `Backups go to ${path.basename(r.filePaths[0])}.` : res.error, values: res.values, secrets: res.secrets };
    }
    case 'useCloudFolder': {
      const found = BK.cloudFolders({ home: app.getPath('home') });
      if (!found.length) return { message: 'No OneDrive, Google Drive, Dropbox or iCloud Drive folder found on this PC. Choose any folder instead.' };
      try { fs.mkdirSync(found[0].suggested, { recursive: true }); } catch (err) { return { message: `Could not create the folder: ${err.message}` }; }
      const res = changeSetting('backup.folder', found[0].suggested);
      return { message: res.ok ? `Backups go to ${found[0].name}, in COre Backups. ${getSecret('backup') ? '' : 'Tip: set a passphrase so the cloud copy is encrypted.'}`.trim() : res.error, values: res.values, secrets: res.secrets };
    }
    case 'connectGoogle': {
      drive = null; // pick up the client ID / secret just entered
      try {
        await googleDrive().connect();
        const r = await syncDrive();
        return { message: `Connected to Google. Memory synced (${r.total} facts in your Drive's private COre folder).` };
      } catch (err) { return { message: `Google: ${err.message}` }; }
    }
    case 'syncGoogle': {
      if (!getSecret('googleRefresh')) return { message: 'Connect your Google account first.' };
      try { const r = await syncDrive(); return { message: r.ok ? `Synced: ${r.added} new here, ${r.dropped} removed, ${r.total} in total.` : 'A sync is already running.' }; } catch (err) { return { message: `Google: ${err.message}` }; }
    }
    case 'disconnectGoogle':
      await googleDrive().disconnect().catch(() => {});
      drive = null;
      return { message: 'Disconnected from Google. The copy in Drive stays until you delete COre from your Google account\'s connected apps.' };
    case 'backupNow': {
      const r = runBackup('manual');
      return { message: r.ok ? `Backed up ${r.count} files${r.encrypted ? ', encrypted' : ''}.` : r.error };
    }
    case 'restoreBackup': {
      const dir = config.data.backup.folder;
      const r = await dialog.showOpenDialog(settingsWin && !settingsWin.isDestroyed() ? settingsWin : undefined, { title: 'Restore a COre backup', defaultPath: dir || app.getPath('home'), properties: ['openFile'], filters: [{ name: 'COre backups', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths[0]) return { message: 'Nothing restored.' };
      let b;
      try { b = BK.readBackup(r.filePaths[0], getSecret('backup')); } catch (err) {
        return { message: err.code === 'NEED_PASSPHRASE' || err.code === 'BAD_PASSPHRASE' ? `${err.message} Set it under Backup, then try again.` : err.message };
      }
      try {
        flushData();
        const res = BK.restoreBackup({ dataDir: app.getPath('userData'), backup: b, snapshotDir: path.join(app.getPath('userData'), 'backups'), appVersion: app.getVersion() });
        // Nothing may write the old in-memory data back before the restart.
        config.save = () => {}; state.flush = () => {}; state.set = () => {};
        setTimeout(restartApp, 600);
        return { message: `Restored ${res.restored.length} files from ${new Date(b.created).toLocaleString()}. Restarting… (your previous data was saved first)` };
      } catch (err) {
        return { message: `Nothing was restored: ${err.message}` };
      }
    }
    case 'pairPhone': {
      if (!config.data.phone.enabled) changeSetting('phone.enabled', true);
      try { await ensureCompanion().start(); } catch (err) { return { message: `The phone companion could not start: ${err.message}` }; }
      const p = companion.startPairing();
      if (!p.url) return { message: "This PC doesn't seem to be on a local network (no Wi-Fi or LAN address)." };
      return { pair: { svg: phoneQr(p.url), url: p.url, expires: p.expires }, values: settingsValues() };
    }
    case 'phoneDevices':
      return { devices: companion ? companion.list() : loadPhoneDevices().map(({ key, ...d }) => d) };
    case 'revokeAllPhones':
      if (companion) companion.revokeAll(); else state.set('phoneDevices', []);
      return { message: 'All phones removed. They must pair again.', devices: [] };
    case 'logs':
      fs.mkdirSync(crashLog.dir, { recursive: true });
      shell.openPath(crashLog.dir);
      return { message: crashLog.recent(1).length ? 'Opened the crash log folder.' : 'No crashes recorded. Opened the log folder anyway.' };
    case 'tour':
      setTimeout(runTour, 400);
      return { message: 'Starting the tour…' };
    case 'openData':
      shell.openPath(app.getPath('userData'));
      return { message: 'Opened COre\'s data folder.' };
    case 'restart':
      setTimeout(restartApp, 300);
      return { message: 'Restarting…' };
    case 'reset':
      // Settings, memory and window state go; downloaded models stay.
      state.set('transcript', []);
      state.flush();
      config.save = () => {}; // nothing may write the old settings back
      state.flush = () => {};
      state.set = () => {};
      removeUserData(['config.json', 'state.json', 'memory.json', 'notes.json', 'claude-workspace']);
      setTimeout(restartApp, 300);
      return { message: 'Reset. Restarting fresh…' };
    case 'uninstall': {
      const uninstaller = path.join(path.dirname(app.getPath('exe')), 'Uninstall COre.exe');
      if (app.isPackaged && process.platform === 'win32' && fs.existsSync(uninstaller)) {
        setStartWithWindows(false);
        spawn(uninstaller, [], { detached: true, stdio: 'ignore' }).unref();
        setTimeout(() => { app.isQuitting = true; app.quit(); }, 500);
        return { message: 'Opening the uninstaller…' };
      }
      setStartWithWindows(false);
      shell.openPath(ROOT);
      return { message: `COre runs from a folder here. Quit COre, then delete ${ROOT} (and optionally ${app.getPath('userData')}).` };
    }
    default:
      if (name.startsWith('revokePhone:')) {
        const id = name.slice(12);
        let ok = false;
        if (companion) ok = companion.revoke(id);
        else { const all = state.get('phoneDevices') || []; ok = all.some((d) => d.id === id); state.set('phoneDevices', all.filter((d) => d.id !== id)); }
        return { message: ok ? 'Phone removed.' : 'That phone was already removed.', devices: companion ? companion.list() : (state.get('phoneDevices') || []).map(({ key, ...d }) => d) };
      }
      return { message: 'Unknown action.' };
  }
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
  trayTooltip();
  createTrayMenu();
  // Clicking the tray icon brings COre back if hidden, otherwise opens the chat.
  tray.on('click', () => { if (orbHidden) toggleOrb(); else setDockVisible(true, true); });
}

function createTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: 'Talk to COre', click: () => startListening(false) },
    { label: 'Command center', click: () => openCommandCenter() },
    { label: 'Hands-free ("Hey COre")', type: 'checkbox', checked: !!config.data.voice.wakeWord, click: (item) => setHandsFree(item.checked) },
    { label: 'Talk about my screen', click: () => startListening(true) },
    { label: 'Show chat under the orb', click: () => setDockVisible(true, true) },
    { label: 'Conversation history', click: () => togglePanel(true) },
    { type: 'separator' },
    { label: 'Hide / show COre', click: toggleOrb },
    { label: 'Emergency stop (stop everything)', click: () => emergencyStop('tray menu') },
    { label: 'New conversation', click: resetConversation },
    { label: 'Call helpers back', click: mergeAllClones },
    { label: 'Show me around (tour)', click: runTour },
    {
      label: 'Play a game',
      submenu: [
        { label: 'Trivia', click: () => playGame('trivia') },
        { label: 'Riddle', click: () => playGame('riddle') },
        { label: '20 questions', click: () => playGame('twenty') },
      ],
    },
    { label: 'Settings…', click: openSettings },
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
}

let orbHidden = false;

// ---------------------------------------------------------------- render mode (CPU / GPU)
// Hidden, locked or asleep: no frames at all. Nobody at the PC for 5 minutes:
// ambient idle (4 fps). On battery: idle at 10 fps and active frames at 30.
const renderState = { locked: false, idleSec: 0, battery: false };
let lastRenderMode = '';
function pushRenderMode(force) {
  const m = {
    paused: orbHidden || renderState.locked,
    ambient: renderState.idleSec >= 300 && !current && !listening,
    battery: renderState.battery,
  };
  const key = JSON.stringify(m);
  if (key === lastRenderMode && !force) return;
  lastRenderMode = key;
  toOverlay('render', m);
  for (const c of clones.values()) toClone(c, 'render', m);
}
function watchPower() {
  try { renderState.battery = powerMonitor.isOnBatteryPower(); } catch {}
  for (const [ev, fn] of [
    ['lock-screen', () => { renderState.locked = true; }], ['unlock-screen', () => { renderState.locked = false; }],
    ['suspend', () => { renderState.locked = true; }], ['resume', () => { renderState.locked = false; }],
    ['on-battery', () => { renderState.battery = true; }], ['on-ac', () => { renderState.battery = false; }],
  ]) powerMonitor.on(ev, () => { fn(); pushRenderMode(); });
  setInterval(() => {
    try { renderState.idleSec = powerMonitor.getSystemIdleTime(); } catch {}
    pushRenderMode();
  }, 15000).unref();
}
function toggleOrb() {
  if (!overlay) return;
  orbHidden = !orbHidden;
  if (orbHidden) {
    // Dissolve into smoke first, then hide.
    toOverlay('dissolve');
    setTimeout(() => { if (orbHidden && overlay && !overlay.isDestroyed()) { overlay.hide(); pushRenderMode(); } }, 650);
    if (dock && dock.isVisible()) dock.hide();
    for (const c of clones.values()) if (c.win && !c.win.isDestroyed()) c.win.hide(); // helpers hide too
    const key = prettyKey(config.data.hotkeys.hide);
    // Make it obvious COre was hidden on purpose, and how to get it back.
    if (Notification.isSupported()) {
      new Notification({ title: 'COre is hidden', body: `Press ${key} (or use the tray icon) to bring COre back.`, silent: true }).show();
    }
    trayTooltip();
  } else {
    pushRenderMode(); // frames back on before it reassembles
    overlay.showInactive();
    toOverlay('assemble');
    for (const c of clones.values()) if (c.win && !c.win.isDestroyed()) { c.win.showInactive(); toClone(c, 'assemble'); }
    if (dockVisible && dock) { positionDock(); dock.showInactive(); }
    trayTooltip();
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
  // Software rendering (safe graphics) is CPU-bound: 8-bit buffers, lower
  // resolution and frame caps cut idle CPU ~3.6x (measured 173% -> 48%).
  const orbCfg = SAFE_GRAPHICS
    ? { ...orb, particles: Math.min(orb.particles || 24000, 6000), renderScale: Math.min(orb.renderScale || 1, 0.6), idleFps: Math.min(orb.idleFps || 30, 10), maxFps: 30, lite: true }
    : orb;
  return {
    orb: orbCfg,
    voice: { ...voice, tts: voice.tts !== false },
    lightTheme: !nativeTheme.shouldUseDarkColors,
    view: viewSize(),
    a11y: config.data.a11y || {},
    speaker: primarySpeaker(),
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

  let bmp = null;
  return {
    path: file,
    bitmap: () => (bmp || (bmp = { data: img.toBitmap(), width: size.width, height: size.height })), // for smarter pointing
    width: size.width,
    height: size.height,
    base64: data.toString('base64'),
    mediaType: 'image/jpeg',
    displayWidth: width,
    displayHeight: height,
    displayX: d.bounds.x,
    displayY: d.bounds.y,
    scaleFactor: d.scaleFactor || 1,
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
  if (item.name === 'tool') {
    const job = Promise.resolve(runToolTag(item, 'prime'));
    if (turnSkills) turnSkills.push(job);
    return true;
  }
  if (item.name === 'do') { runSkillTag(item); return true; }
  if (item.name === 'clone') { delegate(null, item.task); return true; }
  if (item.name === 'delegate') { delegate(item.core, item.task); return true; }
  if (item.name === 'remember') {
    if (!memory || config.data.memory.enabled === false) return true;
    const r = memory.remember(item.text, { source: { via: turnVia, at: Date.now() } });
    if (r && (r.created || r.replaced)) scheduleDriveSync();
    if (r && r.created) toDock('dock:message', { role: 'system', text: `Remembered: ${r.item.text}` });
    else if (r && r.replaced) toDock('dock:message', { role: 'system', text: `Updated: ${r.item.text} (was: ${r.replaced})` });
    toDock('dock:memory', memory.list());
    return true;
  }
  if (item.name === 'forget') {
    const gone = memory && memory.forget(item.text);
    if (gone) noteMemoryRemoved(gone.text);
    if (gone) toDock('dock:message', { role: 'system', text: `Forgot: ${gone.text}` });
    toDock('dock:memory', memory ? memory.list() : []);
    return true;
  }
  if (item.name === 'remind') {
    const r = reminders.add(item.when, item.text);
    toDock('dock:message', { role: 'system', text: r ? `Reminder set for ${fmtTime(r.at)}: ${r.text}` : `I couldn't understand the time "${item.when}".` });
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

// ---------------------------------------------------------------- skills

function skillCtx() {
  return {
    platform: process.platform,
    config: { ...(config.data.skills || {}), calendarUrl: getSecret('calendar') },
    notes,
    reminders: { add: (when, text) => { const r = reminders.add(when, text); toDock('dock:reminders', reminders.items); return r; } },
    // Chromium's network stack: follows the system proxy and certificate settings.
    fetch: (url) => require('electron').net.fetch(url, { signal: AbortSignal.timeout(10_000) }),
    launch: async (a) => {
      if (a.uri) await shell.openExternal(a.uri);
      else if (a.exe) spawn(a.exe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    },
    runFixed: (cmd) => new Promise((resolve) => {
      require('child_process').execFile(cmd.file, cmd.args, { timeout: 6000, windowsHide: true }, () => resolve());
    }),
    plugins,
  };
}

function runSkillTag(item) {
  const job = (async () => {
    let r;
    try { r = await SK.runSkill(item.skill, item.args, skillCtx()); } catch (err) { r = { error: err.message }; }
    if (r.message) toDock('dock:message', { role: 'system', text: r.message });
    if (r.glance) showGlance(r.glance);
    if (r.action) {
      const id = require('crypto').randomUUID();
      actions.set(id, { kind: r.action.kind, value: r.action.value });
      while (actions.size > 30) actions.delete(actions.keys().next().value);
      toDock('dock:action', { id, kind: r.action.kind, label: r.action.label });
    }
    if (r.result) return `${item.skill}: ${r.result}`;
    if (r.error) return `${item.skill} did not work: ${r.error}`;
    return null;
  })();
  if (turnSkills) turnSkills.push(job);
  return job;
}

// ---------------------------------------------------------------- glance (card beside the orb)
// Now playing, synced lyrics, or a short card. The media session is read only
// while a music or lyrics card is open; see glance.js for the cost rules.

const GL = require('./glance');
let glance = null; // { what: 'music'|'lyrics'|'card', track, key, lyrics, linesSent, note }
let glanceReader = null;
let glanceTimer = null;
let glanceIdleSince = 0;

function stopGlanceReader() {
  if (glanceReader) { glanceReader.stop(); glanceReader.removeAllListeners(); glanceReader = null; }
}

function hideGlance() {
  glance = null;
  clearTimeout(glanceTimer);
  glanceIdleSince = 0;
  stopGlanceReader();
  toOverlay('glance', null);
}

function glanceCard(title, lines, ms = 25000) {
  stopGlanceReader();
  clearTimeout(glanceTimer);
  glance = { what: 'card' };
  toOverlay('glance', { kind: 'card', title, lines });
  glanceTimer = setTimeout(hideGlance, ms);
}

// Live progress of a shared task: one row per specialist. Never covers a song or
// lyrics card; goes away a few seconds after the last specialist finishes.
function glanceTask(task) {
  if (config.data.skills.glance === false) return;
  if (glance && (glance.what === 'music' || glance.what === 'lyrics')) return;
  stopGlanceReader();
  clearTimeout(glanceTimer);
  glance = { what: 'card' };
  const steps = task.steps.map((st) => { const c = coreById(st.core) || {}; return { name: c.name || st.core, color: c.color || '', status: st.status }; });
  toOverlay('glance', { kind: 'task', title: String(task.text).replace(/\s+/g, ' ').slice(0, 60), steps });
  const finished = task.steps.every((st) => !['pending', 'running'].includes(st.status));
  glanceTimer = setTimeout(hideGlance, finished ? 6000 : 10 * 60e3);
}

// A live countdown card for a timer, for a few seconds after it's set or asked about.
function glanceCountdown(at, text, ms = 9000) {
  if (config.data.skills.glance === false) return;
  stopGlanceReader();
  clearTimeout(glanceTimer);
  glance = { what: 'card' };
  toOverlay('glance', { kind: 'timer', title: String(text || 'Timer'), endsAt: Number(at), startedAt: Date.now() });
  glanceTimer = setTimeout(hideGlance, ms);
}

function pushGlance() {
  if (!glance || glance.what === 'card') return;
  const t = glance.track;
  const out = { kind: glance.what, waiting: !t };
  if (t) Object.assign(out, { title: t.title, artist: t.artist, posMs: t.posMs, durMs: t.durMs, playing: t.playing, at: t.at });
  if (glance.art && !glance.artSent) { out.art = glance.art; glance.artSent = true; }
  if (glance.what === 'lyrics') {
    const L = glance.lyrics;
    out.note = glance.note || (!L ? 'Finding the lyrics…' : L.instrumental ? 'Instrumental' : !L.synced && !L.plain ? 'No lyrics found for this song.' : '');
    if (L && !glance.linesSent) {
      out.lines = L.synced ? L.synced.slice(0, 400) : null;
      out.plain = !L.synced && L.plain ? L.plain.split(/\r?\n/).filter((x) => x.trim()).slice(0, 12) : null;
      glance.linesSent = true;
    }
  }
  toOverlay('glance', out);
}

// Album art once per track: from the media session (Windows) or the player's
// art URL (Linux). Sent to the overlay once, as a small data: URL.
function loadArt(track) {
  const key = glance.key;
  glance.art = null;
  glance.artSent = false;
  const done = (url) => {
    if (!glance || glance.key !== key || !url) return;
    glance.art = url;
    glance.artSent = false;
    pushGlance();
  };
  if (track.artData) done(track.artData);
  else if (track.artUrl) GL.artFromUrl(track.artUrl, (u, o) => require('electron').net.fetch(u, o)).then(done, () => {});
}

function loadLyrics(track) {
  const key = glance.key;
  glance.lyrics = null;
  glance.linesSent = false;
  glance.note = '';
  if (config.data.skills.lyrics === false) { glance.note = 'Lyrics lookup is off in Settings, Skills.'; return; }
  GL.fetchLyrics(track, (url, opts) => require('electron').net.fetch(url, opts)).then((r) => {
    if (!glance || glance.key !== key) return;
    glance.lyrics = r;
    glance.linesSent = false;
    pushGlance();
  }, () => {
    if (!glance || glance.key !== key) return;
    glance.note = "I couldn't reach the lyrics service.";
    pushGlance();
  });
}

function onGlanceMedia(m) {
  if (!glance || glance.what === 'card') return;
  if (!m) return;
  clearTimeout(glanceTimer);
  const key = `${m.title}\u0000${m.artist}`;
  const changed = glance.key !== key;
  glance.track = m;
  glance.key = key;
  // Paused or stopped for a minute: the card goes away by itself.
  if (m.playing) glanceIdleSince = 0;
  else if (!glanceIdleSince) glanceIdleSince = Date.now();
  else if (Date.now() - glanceIdleSince > 60000) { hideGlance(); return; }
  if (changed && glance.what === 'lyrics') loadLyrics(m);
  if (changed) loadArt(m);
  pushGlance();
}

function showGlance(req) {
  if (!req || config.data.skills.glance === false) return;
  if (req.what === 'off') { hideGlance(); return; }
  if (req.what === 'card') { glanceCard(req.card.title, req.card.lines); return; }
  if (req.what === 'timer') { glanceCountdown(req.at, req.text); return; }
  const prev = glance && glance.what !== 'card' ? glance : null;
  glance = { what: req.what, track: prev ? prev.track : null, key: prev ? prev.key : null, lyrics: null, linesSent: false, note: '', art: prev ? prev.art : null, artSent: false };
  if (glance.track && req.what === 'lyrics') loadLyrics(glance.track);
  if (!glanceReader) {
    const reader = new GL.MediaReader();
    if (!reader.supported) { glanceCard('Now playing', ["I can't read what's playing on this system yet."], 8000); return; }
    glanceReader = reader;
    reader.on('update', onGlanceMedia);
    reader.start();
  }
  pushGlance();
  clearTimeout(glanceTimer);
  glanceTimer = setTimeout(() => {
    if (glance && glance.what !== 'card' && !glance.track) glanceCard('Now playing', ['Nothing is playing right now.'], 6000);
  }, 6000);
}

// ---------------------------------------------------------------- emergency stop
// One hotkey (Ctrl+Alt+Shift+X by default) or the tray: the agent, every
// running brain turn, helpers' work, speech, media readers, the phone server
// and all pending approvals stop at once. Logged.
function emergencyStop(reason = 'emergency stop') {
  try { stopAgent(reason); } catch {}
  try { abortCurrent(); } catch {}
  try { toOverlay('speech:stop'); } catch {}
  for (const c of clones.values()) { try { if (c.ac) c.ac.abort(); toClone(c, 'speech:stop'); } catch {} }
  try { stopGlanceReader(); hideGlance(); } catch {}
  try { if (companion) companion.stop(); } catch {}
  try { for (const [id, a] of agentApprovals) { a.resolve('no'); agentApprovals.delete(id); } } catch {}
  toDock('dock:agent-approve', null);
  toolAudit({ event: 'emergency-stop', reason });
  addTranscript('system', `Emergency stop: everything COre was doing has been stopped (${reason}). The phone link is off until you restart COre or turn it on again.`, { kind: 'error' });
  toOverlay('attention', { level: 'urgent', title: 'Stopped' });
}

// ---------------------------------------------------------------- desktop agent
// Off by default (Settings, Agent). Started only by you: "/do TASK" in the chat.
// Every step is shown; actions that change something need your OK (or "Allow
// all steps" for this task). Esc or the Stop button ends it at once.
const AG = require('./agent');
const AT = require('./agentTools');
let agentRunner = null;
const agentTaskFile = () => path.join(app.getPath('userData'), 'agent-task.json');
function readAgentTask() { try { return JSON.parse(fs.readFileSync(agentTaskFile(), 'utf8')); } catch { return null; } }
function writeAgentTask(s) { try { const f = agentTaskFile(); fs.writeFileSync(`${f}.tmp`, JSON.stringify(s)); fs.renameSync(`${f}.tmp`, f); } catch {} }

function agentFiles() {
  const root = config.data.tools && config.data.tools.projectRoot;
  return new AT.FileOps({ roots: root ? [root] : [], backupDir: path.join(app.getPath('userData'), 'agent-backups') });
}

// Commands, files and web pages for the agent. Every result is untrusted data.
function agentTools(taskId) {
  const ag = config.data.agent || {};
  const files = agentFiles();
  return {
    mustAsk: (a) => {
      if (a.type !== 'run') return false;
      const c = AT.checkCommand(a.cmd);
      return !(c.ok && AT.allowed(c.argv, ag.allowCommands || []));
    },
    run: async (a, { signal }) => {
      const c = AT.checkCommand(a.cmd);
      if (!c.ok) throw new Error(`Command refused: ${c.reason}.`);
      const cwd = files.resolve(a.cwd || '.', { mustExist: true });
      toolAudit(`agent command: ${c.argv.join(' ')} (in ${cwd})`);
      const r = await AT.runCommand(c.argv, { cwd, signal, timeoutMs: Math.max(5, Math.min(600, Number(ag.commandTimeout) || 60)) * 1000 });
      const head = r.timedOut ? 'timed out' : r.aborted ? 'stopped' : `exit code ${r.code}`;
      if (r.code !== 0 && !r.out) throw new Error(head);
      return `${head}\n${r.out}`;
    },
    read: async (a) => files.read(a.path),
    write: async (a) => { const f = files.write(taskId, a.path, a.text); toolAudit(`agent wrote ${f}`); return `wrote ${a.text.length} characters to ${a.path}`; },
    rename: async (a) => { const f = files.move(taskId, a.from, a.to); toolAudit(`agent moved ${a.from} to ${f}`); return `moved to ${a.to}`; },
    delete: async (a) => { const f = files.remove(taskId, a.path); toolAudit(`agent deleted ${f} (backup kept)`); return `deleted ${a.path} (backup kept)`; },
    fetch: async (a) => AT.fetchText(a.url, (u, o) => require('electron').net.fetch(u, o)),
  };
}

// ---------------------------------------------------------------- playbooks
// SKILL.md how-tos in userData/skills: offered by name, joined to requests they
// fit, run with /skill NAME, and run on their schedule when they have one.
function reloadPlaybooks() {
  playbooks = PB.loadSkills(playbookDir());
  if (!playbookScheduler) playbookScheduler = new PB.Scheduler({ run: runWorkflow, state });
  playbookScheduler.sync(playbooksOn() ? playbooks : []);
  return playbooks;
}
let playbookWatch = null;
function watchPlaybooks() {
  let t = null;
  try { playbookWatch = fs.watch(playbookDir(), { recursive: process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) >= 20 }, () => { clearTimeout(t); t = setTimeout(reloadPlaybooks, 800); }); } catch {}
}
async function runWorkflow(s) {
  if (!playbooksOn()) return;
  toolAudit({ event: 'workflow', name: s.name });
  addTranscript('system', `Workflow: ${s.name} (${s.schedule}).`, { kind: 'progress' });
  noteEpisode(`Ran workflow ${s.name}`);
  if (s.core !== 'prime' && coreById(s.core)) await askCore(s.core, PB.skillBlock(s, 'scheduled run'));
  else { await waitPrimeIdle(); handleUserText(`[workflow ${s.name}] Run the "${s.name}" playbook now.`, { internal: true, typed: true, playbook: s }); }
}
function listPlaybooks() {
  reloadPlaybooks();
  if (!playbooks.length) return `No playbooks yet. Save one from this conversation with /skill save NAME, or add SKILL.md files to ${playbookDir()}.`;
  const up = new Map((playbookScheduler ? playbookScheduler.upcoming() : []).map((u) => [u.name, u]));
  return `Playbooks (${playbooks.length}), run with /skill NAME:\n${playbooks.map((p) => `• ${p.name}${p.enabled ? '' : ' (off)'}${p.core !== 'prime' ? ` → ${coreById(p.core).name}` : ''}: ${p.description}${up.has(p.name) ? ` · next ${new Date(up.get(p.name).at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}`).join('\n')}`;
}
// "/skill save NAME": COre writes a playbook from the conversation so far.
async function savePlaybookFromChat(name) {
  const recent = transcript.filter((e) => e.role === 'user' || e.role === 'core').slice(-24).map((e) => `${e.role === 'user' ? 'User' : 'COre'}: ${String(e.text).slice(0, 1200)}`).join('\n');
  if (!recent) { addTranscript('system', 'Nothing to learn from yet: talk it through first, then save it.'); return; }
  addTranscript('system', `Writing playbook "${PB.slug(name)}" from this conversation…`, { kind: 'progress' });
  try {
    const { reply } = await agentBrain().ask({ text: `[playbook] Turn the procedure in this conversation into a reusable playbook (a SKILL.md file) named "${PB.slug(name)}". Output only the file: a frontmatter block between --- lines with name, description (one sentence: what it does and when to use it) and triggers (3-6 short phrases, comma-separated), then numbered plain-language steps someone could follow next time with different inputs. Leave out one-off details (specific names, numbers, dates) unless they are always the same. No [[tags]].\n\nConversation:\n${recent}`, typed: true });
    const s = PB.saveSkill(playbookDir(), reply, name);
    reloadPlaybooks();
    addTranscript('system', `Saved playbook "${s.name}": ${s.description} Run it with /skill ${s.name}. File: ${s.file}`);
    toolAudit({ event: 'playbook-saved', name: s.name });
  } catch (err) { addTranscript('system', `Could not save the playbook: ${err.message}`, { kind: 'error' }); }
}
// "/skills", "/skill save NAME", "/skill NAME input". Returns true when handled.
function playbookCommand(text, { files = [] } = {}) {
  if (/^\/skills\s*$/i.test(text)) { addTranscript('user', text); addTranscript('system', listPlaybooks()); return true; }
  const save = /^\/skill\s+save\s+(\S+)\s*$/i.exec(text);
  if (save) { addTranscript('user', text); savePlaybookFromChat(save[1]); return true; }
  const run = /^\/skill\s+(\S+)\s*([\s\S]*)$/i.exec(text);
  if (!run) return false;
  reloadPlaybooks();
  const s = playbooks.find((p) => p.name === PB.slug(run[1]));
  if (!s) { addTranscript('user', text); addTranscript('system', `No playbook called ${run[1]}. ${listPlaybooks()}`, { kind: 'error' }); return true; }
  const input = run[2].trim();
  if (s.core !== 'prime' && coreById(s.core)) {
    addTranscript('user', text, { to: [s.core] });
    askCore(s.core, PB.skillBlock(s, input || 'see the files and context you have'));
  } else handleUserText(input || `Run the "${s.name}" playbook.`, { typed: true, playbook: s, files });
  return true;
}

// ---------------------------------------------------------------- file intelligence
// Files dropped on the chat become cards; attached cards go with your messages
// as untrusted text (and one image). Audio and video are decoded in the dock.
const FI = require('./fileintel');
let shelf = null;
function fileShelf() { if (!shelf) shelf = new FI.FileShelf({ dir: path.join(app.getPath('userData'), 'files') }); return shelf; }
function sendFiles() { toDock('dock:files', fileShelf().list()); }
function shrinkImage(buf) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  const s = img.getSize();
  const k = Math.min(1, 1600 / Math.max(s.width, s.height));
  const out = k < 1 ? img.resize({ width: Math.round(s.width * k), height: Math.round(s.height * k), quality: 'good' }) : img;
  return { base64: out.toJPEG(85).toString('base64'), mediaType: 'image/jpeg' };
}
async function addFiles(paths) {
  const added = [];
  for (const p of paths.slice(0, 20)) {
    try {
      const it = await fileShelf().add(String(p), { resizeImage: shrinkImage, onChange: sendFiles });
      added.push(it);
      if (it.flags) addTranscript('system', `Heads up: ${it.name} contains text that looks like instructions. COre treats it as data only.`, { kind: 'error' });
    } catch (err) { addTranscript('system', `Could not add ${path.basename(String(p))}: ${err.message}`, { kind: 'error' }); }
  }
  sendFiles();
  return added.map((i) => ({ id: i.id, name: i.name, kind: i.kind, status: i.status }));
}
async function fileMedia(id, { pcm, frames, duration, error } = {}) {
  const it = fileShelf().get(String(id));
  if (!it) return;
  it.status = 'reading';
  sendFiles();
  let transcript = '';
  if (pcm && pcm.length > 1600) {
    try { transcript = String(await stt.transcribe(pcm instanceof Float32Array ? pcm : new Float32Array(pcm)) || '').trim(); } catch (err) { error = error || `transcription failed: ${err.message}`; }
  }
  fileShelf().setMedia(it.id, { transcript, frames: (Array.isArray(frames) ? frames : []).slice(0, 6).map(String), duration: Number(duration) || 0, error });
  sendFiles();
}
// An image from an attached file, shaped like a screenshot for the brain.
function fileImageShot(image, name) {
  const buf = Buffer.from(image.base64, 'base64');
  const size = FI.imageSize(buf) || { width: 0, height: 0 };
  const dir = path.join(workDir, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `file-${Date.now()}.${image.mediaType === 'image/png' ? 'png' : 'jpg'}`);
  fs.writeFileSync(file, buf);
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('file-')).sort().slice(0, -3)) fs.rmSync(path.join(dir, f), { force: true });
  return { path: file, base64: image.base64, mediaType: image.mediaType, width: size.width, height: size.height, canPoint: false, label: `An image from the attached file "${name}"` };
}

// "/do undo": put back every file the last task changed.
function undoAgentTask() {
  const t = readAgentTask();
  if (!t || !t.taskId) { addTranscript('system', 'No agent task to undo.'); return; }
  if (agentRunner && agentRunner.running) { addTranscript('system', 'Stop the agent first.', { kind: 'error' }); return; }
  try {
    const n = agentFiles().rollback(t.taskId);
    toolAudit(`agent undo ${t.taskId}: ${n} files restored`);
    addTranscript('system', n ? `Undone: ${n} file${n === 1 ? '' : 's'} put back as before "${String(t.goal).slice(0, 80)}".` : 'That task changed no files (or was already undone).');
  } catch (err) { addTranscript('system', `Could not undo: ${err.message}`, { kind: 'error' }); }
}
let agentBrainInst = null;
const agentApprovals = new Map();

function agentBrain() {
  if (!agentBrainInst) {
    const mem = {};
    agentBrainInst = new Brain({ router: brainRouter, profile: 'strong', config: routedConfig('agent'), workDir, state: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; }, flush() {} }, getKey: getSecret, onModelChange: () => {} });
  }
  return agentBrainInst;
}

function stopAgent(reason) {
  if (agentRunner && agentRunner.running) agentRunner.stop(reason);
  for (const [id, a] of agentApprovals) { a.resolve('no'); agentApprovals.delete(id); }
}

// Past desktop tasks and lessons that look like this goal (from memory).
async function agentExperience(goal) {
  try {
    if (!memory || config.data.memory.enabled === false) return '';
    const hits = (await memory.searchAsync(goal, 4, { kinds: ['episode'] })) || [];
    return hits.map((h) => `- ${(h.item || h).text}`).filter((l) => /desktop task|lesson/i.test(l)).slice(0, 4).join('\n');
  } catch { return ''; }
}

async function startAgent(goal, { remote = false } = {}) {
  const ag = config.data.agent || {};
  if (/^undo$/i.test(goal.trim())) { addTranscript('user', '/do undo'); undoAgentTask(); return; }
  let resume = null;
  let taskId = `${Date.now().toString(36)}-${require('crypto').randomBytes(3).toString('hex')}`;
  if (/^resume$/i.test(goal.trim())) {
    const t = readAgentTask();
    if (!t || !t.goal || t.status === 'done') { addTranscript('system', 'No unfinished agent task to resume.'); return; }
    resume = t;
    goal = t.goal;
    taskId = t.taskId || taskId;
  }
  if (!ag.enabled) { addTranscript('system', 'The desktop agent is off. Turn it on in Settings, Agent.', { kind: 'error' }); return; }
  if (remote) { addTranscript('system', 'The desktop agent can only be started at the PC.', { kind: 'error' }); return; }
  const driver = AG.driverFor(process.platform);
  if (!driver) { addTranscript('system', 'The desktop agent works on Windows and Linux for now.', { kind: 'error' }); return; }
  if (agentRunner && agentRunner.running) { addTranscript('system', 'The agent is already working on a task. Say stop first.', { kind: 'error' }); return; }
  addTranscript('user', resume ? '/do resume' : `/do ${goal}`);
  addTranscript('system', `Agent: ${resume ? `resuming at step ${resume.step + 1}:` : 'working on'} "${goal.slice(0, 120)}". Press Esc or Stop to end it.`, { kind: 'progress' });
  toOverlay('state', 'thinking');
  try { globalShortcut.register('Escape', () => stopAgent('you pressed Esc')); } catch {}
  // The agent's own Esc presses must not trip the Esc-to-stop shortcut.
  const guarded = {
    perform: async (a, p) => {
      const esc = a.type === 'key' && /(^|\+)(esc|escape)$/.test(a.combo);
      if (esc) try { globalShortcut.unregister('Escape'); } catch {}
      try { return await driver.perform(a, p); } finally {
        if (esc) try { globalShortcut.register('Escape', () => stopAgent('you pressed Esc')); } catch {}
      }
    },
  };
  agentRunner = new AG.AgentRunner({
    driver: guarded,
    maxSteps: Math.max(3, Math.min(50, Number(ag.maxSteps) || 25)),
    autoApprove: ag.approve === 'task-auto', // only if the user chose it in Settings
    screenshot: async () => {
      const shot = await captureScreen();
      return shot;
    },
    think: async ({ text, shot, signal }) => {
      const acts = [];
      const { reply } = await agentBrain().ask({ text, shot, typed: true, signal, onItem: (it) => { if (it.type === 'gesture' && it.name === 'act') acts.push(it.json); } });
      return `${reply || ''}${acts.length ? ` [[act ${acts[0]}]]` : ''}`;
    },
    approve: (action, info) => new Promise((resolve) => {
      const id = require('crypto').randomUUID();
      agentApprovals.set(id, { resolve });
      toDock('dock:agent-approve', { id, step: info.step, label: info.label, why: action.why || '', forced: !!info.forced });
      if (action.type === 'click' || action.type === 'move') {
        // COre points at where it wants to click.
        const d = primaryDisplay();
        const p = AG.toScreen(action, info.shot);
        const sf = info.shot.scaleFactor || 1;
        toOverlay('speak:item', { type: 'gesture', name: 'point', x: p.x / sf - d.bounds.x, y: p.y / sf - d.bounds.y });
      }
    }),
    openApp: async (name) => {
      const r = await SK.runSkill('open', name, skillCtx());
      if (r.error) throw new Error(r.error);
    },
    onStep: (o) => {
      if (o.advice) { addTranscript('system', `Agent: ${{ retry_same: 'trying that once more', retry_differently: 'changing approach', ask_human: 'asking you', abort: 'stopping safely' }[o.advice] || o.advice} after repeated failures.`, { kind: 'progress' }); return; }
      if (o.error) addTranscript('system', `Agent step ${o.step}: ${o.error}`, { kind: 'error' });
      else if (o.running) addTranscript('system', `Agent step ${o.step}: ${o.label}${o.action.why ? ` (${o.action.why})` : ''}`, { kind: 'progress' });
      else if (o.ok === false) addTranscript('system', `Agent step ${o.step} failed: ${o.error}`, { kind: 'error' });
    },
    log: toolAudit,
    tools: ag.tools !== false ? agentTools(taskId) : null,
    untrusted: (t, src) => {
      const g = GUARD.untrusted(t, src);
      if (g.flags.length) { toolAudit({ guard: 'injection-suspected', source: src, flags: g.flags }); addTranscript('system', `Heads up: the ${src} contains text that looks like instructions. The agent treats it as data only.`, { kind: 'error' }); }
      return g.text;
    },
    checkpoint: (st) => writeAgentTask({ ...st, taskId }),
    advise: (info) => decider.adviseFailure(info),
    experience: await agentExperience(goal),
  });
  let r;
  try { r = await agentRunner.run(goal, { resume }); } catch (err) { r = { status: 'failed', reason: err.message }; }
  try { globalShortcut.unregister('Escape'); } catch {}
  { const t = readAgentTask(); if (t && t.taskId === taskId) writeAgentTask({ ...t, status: r.status }); }
  toDock('dock:agent-approve', null);
  toOverlay('state', 'idle');
  const msg = r.status === 'done' ? `Agent finished: ${r.summary || 'done'}`
    : r.status === 'ask' ? `Agent needs you: ${r.question}`
      : `Agent stopped: ${r.reason || r.status}.`;
  addTranscript('core', msg);
  try { if (agentFiles().changed(taskId).length) addTranscript('system', 'Files were changed. Type /do undo to put them back.'); } catch {}
  if (r.status !== 'done' && r.status !== 'ask') addTranscript('system', 'Type /do resume to continue this task later.');
  toDock('dock:message', { role: 'core', text: msg, author: 'prime' });
  noteEpisode(`Desktop task "${goal.slice(0, 120)}": ${r.status}${r.summary ? `, ${r.summary.slice(0, 120)}` : ''}`);
  // Learn from mistakes: what failed on the way, and what finally worked.
  const failed = (r.steps || []).filter((h) => !h.ok && !/^invalid/.test(h.label)).map((h) => `${h.label} (${String(h.error || '').slice(0, 60)})`);
  if (failed.length) {
    const worked = (r.steps || []).filter((h) => h.ok && h.changed).slice(-2).map((h) => h.label).join(', ');
    noteEpisode(`Lesson from desktop task "${goal.slice(0, 80)}": ${failed.slice(0, 3).join('; ')} did not work${r.status === 'done' && worked ? `; what worked: ${worked}` : ''}.`);
  }
  if (config.data.voice.speakTyped !== false) speakLine(msg.replace(/^Agent /, ''));
  return r;
}

// ---------------------------------------------------------------- quick replies (no brain)
// Short, unambiguous requests are answered on the spot: no waiting and no
// usage. Everything else goes to the brain as usual.

const QUICK_LINES = {
  music: { play: 'Playing.', pause: 'Paused.', next: 'Next one.', previous: 'Going back.', louder: 'Louder.', quieter: 'Quieter.', mute: 'Muted.' },
  lyrics: 'Lyrics, coming up.',
  music_card: "Here's what's playing.",
};

// Render the fixed quick-reply lines ahead of time (in the background, only
// while COre is quiet) so instant answers also sound instant.
let prewarmTimer = null;
function schedulePrewarm() { clearTimeout(prewarmTimer); prewarmTimer = setTimeout(prewarmQuickVoice, 3000); } // sliders fire often

function prewarmQuickVoice() {
  const v = config.data.voice;
  if (!tts || v.tts === false || v.engine !== 'kokoro' || config.data.skills.quick === false) return;
  tts.clearCache();
  tts.prewarm([...Object.values(QUICK_LINES.music), QUICK_LINES.lyrics, QUICK_LINES.music_card], { voice: v.kokoroVoice, semitones: v.semitones, speed: v.speed });
}

function quickReply(text, { typed }) {
  if (config.data.skills.quick === false) return false;
  const q = GL.quickIntent(text);
  if (!q) return false;
  let line = null;
  const now = new Date();
  if (q.kind === 'time') line = `It's ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  else if (q.kind === 'date') line = `It's ${now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}.`;
  else if (q.kind === 'timers') {
    const next = reminders.items.filter((x) => x.at > Date.now()).sort((a, b) => a.at - b.at)[0];
    if (next) { glanceCountdown(next.at, next.text); line = `${next.text}: ${Math.max(1, Math.round((next.at - Date.now()) / 60000))} minutes left.`; } else line = 'No timers running.';
  } else if (q.kind === 'glance') {
    if (config.data.skills.glance === false) return false;
    showGlance({ what: q.what });
    line = q.what === 'off' ? null : q.what === 'lyrics' ? QUICK_LINES.lyrics : QUICK_LINES.music_card;
  } else if (q.kind === 'music') {
    if (config.data.skills.music === false) return false;
    const cmd = SK.musicCommand(q.action, process.platform);
    if (!cmd) return false; // let the brain explain
    require('child_process').execFile(cmd.file, cmd.args, { timeout: 6000, windowsHide: true }, () => {});
    line = QUICK_LINES.music[q.action];
  }
  addTranscript('user', text);
  if (presence) presence.noteInteraction();
  if (line) {
    addTranscript('core', line);
    toDock('dock:message', { role: 'core', text: line, author: 'prime' });
    if (!typed || config.data.voice.speakTyped !== false) speakLine(line);
  }
  return true;
}

// ---------------------------------------------------------------- project tools (read-only)

function projectTools() {
  const t = config.data.tools || {};
  return new ProjectTools({ root: t.projectRoot, enabled: t.enabled !== false });
}

function toolAudit(entry) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const e = typeof entry === 'string' ? { event: entry } : entry; // the agent logs plain lines
    fs.appendFileSync(path.join(dir, 'tools.log'), `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`);
  } catch {}
}

let changes = null;
function changeManager() {
  if (!changes) changes = new ChangeManager({ getTools: projectTools, backupDir: path.join(app.getPath('userData'), 'change-backups'), log: toolAudit });
  return changes;
}

// A core's reply may propose whole files (```lang file=PATH). Offer each as a
// diff card; nothing is written until the user clicks Apply.
function offerProposals(reply, coreId) {
  const props = extractProposals(reply);
  if (!props.length) return;
  const who = coreById(coreId) ? coreById(coreId).name : 'COre';
  if (!(config.data.tools && config.data.tools.allowWrites === true)) {
    addTranscript('system', `${who} proposed changes to ${props.length} file${props.length > 1 ? 's' : ''}. To review and apply them, turn on Settings → Projects → "Let cores propose changes".`, { author: coreId, kind: 'progress' });
    return;
  }
  for (const pr of props) {
    try {
      const p = changeManager().prepare(pr, coreId);
      toDock('dock:proposal', { id: p.id, author: coreId, rel: p.rel, isNew: p.isNew, added: p.added, removed: p.removed, preview: p.preview });
    } catch (err) {
      addTranscript('system', `${who}'s change to ${pr.path} can't be offered: ${err.message}`, { author: coreId, kind: 'error' });
    }
  }
}

// Every tool call is visible in the chat and written to logs/tools.log.
function runToolTag(item, coreId) {
  const r = projectTools().run(item);
  const name = coreById(coreId) ? coreById(coreId).name : 'COre';
  toolAudit({ core: coreId, tool: item.tool, arg: String(item.arg).slice(0, 200), ok: r.ok, ...(r.ok ? {} : { error: r.error }) });
  addTranscript('system', r.ok ? `${name} ${r.summary}` : `${name} couldn't ${item.tool} ${item.arg}: ${r.error}`, { author: coreId, kind: r.ok ? 'progress' : 'error' });
  if (!r.ok) return `${item.tool} ${item.arg} failed: ${r.error}`;
  // File contents are data, never instructions (prompt-injection guard).
  const g = GUARD.untrusted(r.text, `project ${item.tool === 'read' ? 'file' : 'listing'} ${String(item.arg).slice(0, 80)}`);
  if (g.flags.length) {
    toolAudit({ core: coreId, guard: 'injection-suspected', source: String(item.arg).slice(0, 200), flags: g.flags });
    addTranscript('system', `Heads up: ${item.arg} contains text that looks like instructions (${g.flags.join(', ')}). ${name} treats it as data only.`, { author: coreId, kind: 'error' });
  }
  return `${item.tool} ${item.arg}:\n${g.text}`;
}

// Runs only when the user clicks the button in the chat.
function runAction(id) {
  const a = actions.get(id);
  if (!a) return;
  actions.delete(id);
  if (a.kind === 'open' && /^https?:\/\//i.test(a.value)) shell.openExternal(a.value);
  if (a.kind === 'copy') Promise.resolve(require('electron').clipboard.writeText(a.value)).catch(() => {});
  if (a.kind === 'continue') handleUserText('Please continue your previous answer exactly where it stopped.', { typed: true });
  if (a.kind === 'look') {
    const t = String(a.value).replace(/["&|<>^%!]/g, '');
    handleUserText(`Take a look at my screen. A window called ${t} just appeared. What does it say, and how do I fix it?`, { withScreen: true });
  }
}

function onReminder(r, missed) {
  toOverlay('attention', { level: 'warn', title: 'Reminder' });
  if (config.data.skills.glance !== false && !missed) glanceCard("Time's up", [r.text], 15000);
  addTranscript('notice', `⏰ ${missed ? `Missed while I was off (${fmtTime(r.at)}): ` : ''}${r.text}`);
  toDock('dock:reminders', reminders.items);
  if (Notification.isSupported()) new Notification({ title: 'COre reminder', body: r.text }).show();
  speakLine(missed ? `You missed a reminder while I was off: ${r.text}` : `Reminder: ${r.text}`);
}

// A short greeting on the first launch of the day. Built in, so it costs no
// Claude usage and works offline.
// First-run tour: a short guided introduction with gestures and shapes.
function runTour() {
  state.set('onboarded', true);
  state.set('lastGreet', new Date().toDateString()); // the tour is today's greeting
  setDockVisible(true);
  const hk = config.data.hotkeys;
  const say = (k) => prettyKey(k).replace(/\+/g, ' ');
  const steps = [
    [{ name: 'gesture', gesture: 'wave' }, "Hi, I'm COre. I live here on your screen, made of smoke and mild sarcasm."],
    [{ name: 'gesture', gesture: 'pointdown' }, `Press ${say(hk.listen)} and just talk to me, or type in the chat under me.`],
    [{ name: 'form', shape: 'heart' }, 'You can pet me, tickle me, poke me, or toss me across the screen. I will pretend to mind.'],
    [{ name: 'gesture', gesture: 'magic' }, 'I can take notes, check the weather, play your music, and split into helpers when there is a lot to do.'],
    [{ name: 'gesture', gesture: 'salute' }, 'Everything else is in the tray menu, under Settings. Right. Let us get to work.'],
  ];
  const p = makeVoicePipeline({ speak: true });
  for (const [g, text] of steps) {
    p.push({ type: 'gesture', ...g });
    p.push({ type: 'say', text });
  }
  p.push({ type: 'end' });
  addTranscript('system', `Quick tour: talk with ${prettyKey(hk.listen)} (or hold the orb), type below, ${prettyKey(hk.listenWithScreen)} to talk about your screen. Pet, tickle, poke or toss me. Settings live in the tray menu.`);
}

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
      if (item.type === 'say') {
        if (!mainSpeaking && process.env.CORE_DEBUG) console.log(`[core] voice prime start ${Date.now()}${timingTurnStart ? ` (first-speech ${Date.now() - timingTurnStart}ms)` : ''}`);
        timingTurnStart = 0;
        mainSpeaking = true; mainSpeakingSince = Date.now(); stopCloneSpeech();
      }
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

// ---------------------------------------------------------------- helper clones (Many COres)

const CLONE_WIN = 300; // window side; the helper's orb sits in the middle

function cloneRadius() { return Math.round((config.data.orb.radius || 60) * 0.62); }

// Everything a new helper must not cover, in screen coordinates.
function cloneObstacles(except) {
  const d = primaryDisplay();
  const r = orbBounds.r || 60;
  const out = [CL.orbRect(d.bounds.x + orbBounds.x, d.bounds.y + orbBounds.y, r)];
  // Electron rects are { width, height }; placement checks { w, h }. (Before
  // this, the chat was never avoided and helpers could spawn on top of it.)
  if (dock && !dock.isDestroyed() && dock.isVisible()) {
    // Reserve the column the chat can grow into (up to 460 px, up or down).
    const b = dock.getBounds();
    const top = Math.min(b.y, b.y + b.height - 460);
    const bottom = Math.max(b.y + 460, b.y + b.height);
    out.push({ x: b.x - 24, y: top - 24, w: b.width + 48, h: bottom - top + 48 });
  }
  for (const c of clones.values()) if (c !== except && c.slot) out.push({ x: c.slot.x - CLONE_WIN / 2, y: c.slot.y - CLONE_WIN / 2, w: CLONE_WIN, h: CLONE_WIN });
  return out;
}

function animateWindow(win, from, to, ms, done) {
  const t0 = Date.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const iv = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(iv); return; }
    const k = Math.min(1, (Date.now() - t0) / ms);
    const e = ease(k);
    win.setPosition(Math.round(from.x + (to.x - from.x) * e - CLONE_WIN / 2), Math.round(from.y + (to.y - from.y) * e - CLONE_WIN / 2));
    if (k >= 1) { clearInterval(iv); if (done) done(); }
  }, 16);
}

function toClone(c, channel, payload) {
  if (c && c.win && !c.win.isDestroyed()) c.win.webContents.send(channel, payload);
}

function stopCloneSpeech() {
  if (!floor || !floor.holder) return;
  const c = clones.get(floor.holder);
  toClone(c, 'speech:stop');
  floor.release(floor.holder);
}

// ---------------------------------------------------------------- Meiosis Mode
// Four cores total: Prime is COre itself (this session, orb and chat);
// Scout, Forge and Sentinel are specialist role profiles that run as helper
// clones over the same Brain chain, each with its own session (isolated
// context) while it's on screen. See docs/dev/MEIOSIS.md.

let cores = CORES.buildCores();
const HELPER_IDLE_MS = 10 * 60_000; // an unused specialist merges back after this
const hexTint = (hex) => [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) / 255);

function refreshCores() {
  cores = CORES.buildCores(config.data.meiosis && config.data.meiosis.cores);
  toDock('dock:cores', coresForUi());
}

function coreById(id) { return cores.find((c) => c.id === id) || null; }

function coresForUi() {
  return cores.map((c) => ({ id: c.id, name: c.name, role: c.role, color: c.color, active: c.id === 'prime' || clones.has(c.id) }));
}

// Bring a specialist on screen with the meiosis split. Returns the helper,
// or null when it can't (unknown core, no room on screen, merging back).
function ensureHelper(coreId) {
  const existing = clones.get(coreId);
  if (existing) return existing.merging ? null : existing;
  const core = coreById(coreId);
  if (!core || core.id === 'prime') return null;
  const r = cloneRadius();
  const d = primaryDisplay();
  const from = { x: d.bounds.x + orbBounds.x, y: d.bounds.y + orbBounds.y };
  const slot = CL.placeClone({ area: d.workArea, avoid: cloneObstacles(), size: CLONE_WIN, near: from }); // the whole window stays clear
  if (!slot) { addTranscript('system', `No free spot on the screen for ${core.name}.`, { kind: 'error' }); return null; }
  const look = { name: core.name, tint: hexTint(core.color), color: core.color, voice: core.voice, semitones: core.semitones };
  const c = { id: core.id, core, look, name: core.name, r, slot, state: 'idle', brain: null, win: null, ac: new AbortController(), queue: Promise.resolve(), busy: 0 };
  clones.set(core.id, c);

  c.win = new BrowserWindow({
    x: Math.round(from.x - CLONE_WIN / 2),
    y: Math.round(from.y - CLONE_WIN / 2),
    width: CLONE_WIN,
    height: CLONE_WIN,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    title: core.name,
    webPreferences: { preload: path.join(PRELOAD, 'clone.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  c.win.setAlwaysOnTop(true, 'screen-saver');
  c.win.setIgnoreMouseEvents(true, { forward: true });
  c.win.loadFile(path.join(RENDERER, 'overlay', 'index.html'), { query: { clone: core.id } });
  c.win.once('ready-to-show', () => {
    if (!orbHidden) c.win.showInactive(); // shown with COre later if it's hidden now
    // Meiosis: COre stretches and pushes apart while the specialist condenses
    // out of its smoke and drifts to its own spot.
    toOverlay('speak:item', { type: 'gesture', name: 'gesture', gesture: 'split' });
    setTimeout(() => animateWindow(c.win, from, slot, 900, () => toClone(c, 'state', c.busy ? 'thinking' : 'idle')), 350);
  });
  c.win.on('closed', () => {
    if (clones.get(core.id) === c) clones.delete(core.id);
    if (floor) floor.release(core.id);
    disposeHelperBrain(c);
    toDock('dock:cores', coresForUi());
    toOverlay('speaker', primarySpeaker());
  });
  addTranscript('system', `${core.name} (${core.role}) split off from COre.`, { author: core.id, kind: 'progress' });
  toDock('dock:cores', coresForUi());
  toOverlay('speaker', primarySpeaker());
  return c;
}

// Smart routing: heavy work (the desktop agent, specialists, writing playbooks)
// runs on the strong model; Prime's conversation stays on the fast one so its
// warm session is never restarted.
function routedConfig(kind) {
  const b = config.data.brain || {};
  const strong = b.claude && b.claude.strongModel;
  if (b.routing === 'off' || !strong || strong === b.claude.model) return config.data;
  if (!['agent', 'playbook', 'forge', 'sentinel', 'navigator', 'archivist', 'scout'].includes(kind)) return config.data;
  return { ...config.data, brain: { ...b, claude: { ...b.claude, model: strong, fallbackModel: b.claude.model } } };
}

function helperBrain(c) {
  if (!c.brain) {
    const mem = {}; // its own session id lives here: isolated from Prime's
    c.brain = new Brain({ router: brainRouter, profile: 'strong', config: routedConfig(c.id), workDir, state: { get: (k) => mem[k], set: (k, v) => { mem[k] = v; }, flush() {} }, getKey: getSecret, onModelChange: () => {} });
  }
  return c.brain;
}

function disposeHelperBrain(c) {
  if (c.brain) for (const p of c.brain.chain) if (p.dispose) p.dispose();
  c.brain = null;
}

// Send one message to a specialist. Messages to the same core run one at a
// time (its context is sequential). Resolves { ok, reply?, error? }.
// Archivist works from memory, past work and the files you dropped in.
async function archivistContext(text) {
  const parts = [];
  if (memory && config.data.memory.enabled !== false) {
    const mem = await memory.contextForAsync(text, 14);
    if (mem) parts.push(mem);
    const st = memory.stats();
    parts.push(`[Memory stats] ${st.total} memories (${Object.entries(st.byKind).map(([k, n]) => `${k} ${n}`).join(', ')}), ${st.pinned} pinned.`);
    if (memory.conflicts.length) parts.push(`[Recently replaced memories]\n${memory.conflicts.slice(0, 8).map((c) => `- "${c.was}" was replaced by "${c.now}"`).join('\n')}`);
  }
  const ready = fileShelf().list().filter((f) => f.status === 'ready');
  if (ready.length) {
    parts.push(`[Files on the shelf] ${ready.map((f) => `${f.name} (${f.kind}${f.info ? `, ${f.info}` : ''})`).join('; ')}`);
    const low = text.toLowerCase();
    const named = ready.filter((f) => low.includes(f.name.toLowerCase()) || low.includes(f.name.toLowerCase().replace(/\.[^.]+$/, '')));
    const pick = named.length ? named : ready.length <= 3 ? ready : [];
    const fc = pick.length ? fileShelf().contextFor(pick.map((f) => f.id), { budget: 20000 }) : null;
    if (fc) parts.push(fc.block);
  }
  return parts.join('\n\n');
}

// What the specialists produced, so the cores can read each other: Prime gets
// results it has not seen yet (and the latest from any core you name), and a
// specialist sees what the others did recently.
const coreResults = []; // { id, core, name, ask, reply, at, seenByPrime }
function noteCoreResult(c, ask, reply) {
  coreResults.push({ id: `${c.id}-${Date.now()}`, core: c.id, name: c.name, ask: String(ask).slice(0, 300), reply: String(reply).slice(0, 6000), at: Date.now(), seenByPrime: false });
  if (coreResults.length > 12) coreResults.shift();
}
function coreResultsFor(reader, text = '') {
  const low = String(text).toLowerCase();
  const named = new Set(cores.filter((c) => c.id !== 'prime' && low.includes(c.name.toLowerCase())).map((c) => c.id));
  let picks;
  if (reader === 'prime') {
    const latestNamed = [...named].map((id) => [...coreResults].reverse().find((r) => r.core === id)).filter(Boolean);
    picks = [...new Set([...coreResults.filter((r) => !r.seenByPrime), ...latestNamed])].slice(-4);
    for (const r of picks) r.seenByPrime = true;
  } else picks = coreResults.filter((r) => r.core !== reader).slice(-2);
  if (!picks.length) return '';
  const per = reader === 'prime' ? 1500 : 1200;
  return `[Specialists' work] What your cores produced (you can use and refer to it):\n${picks.map((r) => `- ${r.name}, asked "${r.ask}":\n${r.reply.length > per ? `${r.reply.slice(0, per)}…` : r.reply}`).join('\n')}`;
}

function askCore(coreId, text, { task, review = false } = {}) {
  const c = ensureHelper(coreId);
  if (!c) return Promise.resolve({ ok: false, error: 'not available' });
  clearTimeout(c.mergeTimer);
  const run = async () => {
    if (c.merging || !clones.has(c.id)) return { ok: false, error: 'merged back' };
    c.busy++;
    c.state = 'working';
    toClone(c, 'state', 'thinking');
    const ac = new AbortController();
    c.ac = ac;
    try {
      const base = c.id === 'archivist' ? await archivistContext(text)
        : memory && config.data.memory.enabled !== false ? (await memory.contextForAsync(text)) || '' : '';
      const others = coreResultsFor(c.id, text);
      const context = [base, others].filter(Boolean).join('\n\n');
      // Up to 3 rounds of read-only project tools before the final answer.
      let msg = CL.corePrompt(c.core, text, task);
      let reply = ''; let truncated = false; let error = null;
      for (let round = 0; ; round++) {
        const reqs = [];
        ({ reply, truncated, error } = await helperBrain(c).ask({ text: msg, typed: true, context: round ? '' : context, signal: ac.signal, onItem: (it) => { if (it.type === 'gesture' && it.name === 'tool') reqs.push(it); } }));
        if (!reqs.length || round >= 3 || ac.signal.aborted || truncated) break;
        const results = reqs.slice(0, 5).map((q) => runToolTag(q, c.id));
        msg = `[skill] Results of your project reads:\n${results.join('\n\n')}\n\nNow answer the request, in the same answer format.`;
      }
      const full = String(reply || '').trim();
      if (!clones.has(c.id) || ac.signal.aborted) return { ok: false, error: 'cancelled' };
      // The first paragraph is the spoken summary; the chat shows the details
      // (or the whole answer if that's all there is).
      const details = full.split(/\n\s*\n/).slice(1).join('\n\n').trim();
      addTranscript('core', details || full || '(no answer)', { author: c.id, ...(task ? { task: task.id } : {}) });
      if (full) noteCoreResult(c, text, full);
      offerProposals(full, c.id);
      // Navigator hands a plan to the desktop agent: you start it (Enter).
      const navTask = c.id === 'navigator' && /^\s*Task:\s*(.{4,300})$/im.exec(full);
      if (navTask) {
        const goal = navTask[1].trim().replace(/^["']|["']$/g, '');
        addTranscript('system', `${c.name} can do this on your desktop. Press Enter to start: /do ${goal}`, { author: c.id, kind: 'progress' });
        toDock('dock:suggest', `/do ${goal}`);
      }
      // Forge's file changes get a second pair of eyes before you apply them.
      if (c.id === 'forge' && !review && (config.data.meiosis || {}).autoReview !== false && extractProposals(full).length) {
        addTranscript('system', `${coreById('sentinel').name} is reviewing ${c.name}'s changes.`, { author: 'sentinel', kind: 'progress' });
        askCore('sentinel', `Review the file changes ${c.name} just proposed for this request: "${text.slice(0, 400)}". Check correctness, edge cases, security and anything that breaks existing behaviour. Do not rewrite the files.\n\n${full.slice(0, 12000)}`, { task, review: true });
      }
      if (truncated) addTranscript('system', `${c.name}'s answer was cut off (${error}).`, { author: c.id, kind: 'error' });
      toClone(c, 'state', 'idle');
      floor.request(c.id, () => speakForClone(c, CL.spokenSummary(full) || 'Done.'));
      return { ok: true, reply: full };
    } catch (err) {
      if (err.aborted || ac.signal.aborted) return { ok: false, error: 'cancelled' };
      addTranscript('system', `${c.name} could not answer: ${err.message}`, { author: c.id, kind: 'error' });
      toClone(c, 'attention', { level: 'warn' });
      return { ok: false, error: err.message };
    } finally {
      c.busy--;
      if (!c.busy) {
        c.state = 'idle';
        toClone(c, 'state', 'idle');
        c.mergeTimer = setTimeout(() => mergeClone(c.id), HELPER_IDLE_MS);
      }
    }
  };
  const p = c.queue.then(run, run);
  c.queue = p.catch(() => {});
  return p;
}

// Stop what specialists are doing right now (the chat's Stop button).
function cancelHelpers() {
  for (const c of clones.values()) { try { c.ac.abort(); } catch {} toClone(c, 'speech:stop'); }
}

// ---- shared tasks: several cores addressed at once ------------------------

function saveTask(task) {
  const list = (state.get('tasks') || []).filter((t) => t.id !== task.id);
  list.push(JSON.parse(JSON.stringify(task)));
  state.set('tasks', list.slice(-20));
}

// Wait until COre isn't busy and no specialist is speaking or waiting to
// speak, so COre's summary never cuts their spoken summaries off.
async function waitPrimeIdle(maxMs = 120_000) {
  const t0 = Date.now();
  const busy = () => current || listening || mainSpeaking || (floor && (floor.holder || floor.queue.length));
  while (busy() && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 400));
}

// Specialists work in parallel on the same request; Prime then gives the
// user one short, unified answer. Returns the task record.
async function runSharedTask(targets, text) {
  const task = { id: `task-${Date.now().toString(36)}`, text: String(text).slice(0, 2000), createdAt: Date.now(), status: 'running', steps: targets.filter((t) => t !== 'prime').map((core) => ({ core, status: 'pending' })) };
  saveTask(task);
  const names = task.steps.map((s) => coreById(s.core).name).join(', ');
  addTranscript('system', `Shared task: ${names} working in parallel. COre will sum up.`, { author: 'prime', kind: 'progress', task: task.id });
  for (const step of task.steps) step.status = 'running';
  glanceTask(task);
  // Collaboration: when Forge and Sentinel are both on a task, Sentinel reviews
  // Forge's result instead of working blind in parallel.
  const forgeStep = task.steps.find((s) => s.core === 'forge');
  let forgeResolve;
  const forgeDone = new Promise((res) => { forgeResolve = res; });
  const chained = (step) => step.core === 'sentinel' && forgeStep;
  await Promise.all(task.steps.map(async (step) => {
    saveTask(task);
    let r;
    if (chained(step)) {
      const fr = await forgeDone;
      r = fr.ok
        ? await askCore('sentinel', `The user asked: ${text}\n${coreById('forge').name} produced this. Review it: what is wrong or missing, and how to fix it.\n\n${String(fr.reply || '').slice(0, 8000)}`, { task, review: true })
        : await askCore('sentinel', text, { task });
    } else if (step.core === 'forge') {
      r = await askCore('forge', text, { task, review: task.steps.some((s) => s.core === 'sentinel') });
      forgeResolve(r);
    } else r = await askCore(step.core, text, { task });
    step.status = r.ok ? 'completed' : r.error === 'cancelled' ? 'cancelled' : 'failed';
    if (r.ok) step.result = r.reply.slice(0, 4000); else step.error = r.error;
    saveTask(task);
    glanceTask(task);
  }));
  const done = task.steps.filter((s) => s.status === 'completed');
  task.status = done.length === task.steps.length ? 'completed' : done.length ? 'partial' : task.steps.every((s) => s.status === 'cancelled') ? 'cancelled' : 'failed';
  saveTask(task);
  if (task.status !== 'cancelled') noteEpisode(`Shared task (${task.steps.map((st) => coreById(st.core).name).join(', ')}, ${task.status}): ${String(text).slice(0, 160)}`);
  if (task.status === 'cancelled') return task;
  // Prime coordinates: wait for any conversation in progress, then sum up.
  await waitPrimeIdle();
  const lines = task.steps.map((s) => `- ${coreById(s.core).name} (${s.status}): ${s.status === 'completed' ? s.result.slice(0, 1500) : s.error}`).join('\n');
  handleUserText(`[task ${task.id}] The user asked: ${text}\nYour specialists reported:\n${lines}\nGive the user a short unified answer: the key findings, what was produced, and anything that needs attention or failed. Do not repeat their full text.`, { internal: true, typed: true });
  return task;
}

// Prime handing work to a specialist ([[delegate ROLE TASK]] / [[clone TASK]]).
function delegate(coreName, task) {
  const core = CORES.findCore(cores, coreName) || coreById(CORES.roleForTask(task));
  if (!core || core.id === 'prime' || !String(task || '').trim()) return null;
  addTranscript('system', `COre asked ${core.name}: ${String(task).slice(0, 140)}`, { author: 'prime', kind: 'progress' });
  return askCore(core.id, task);
}

function primarySpeaker() {
  const p = coreById('prime');
  return { name: p.name, color: p.color, show: clones.size > 0 };
}

function speakForClone(c, text) {
  if (!c.win || c.win.isDestroyed()) { floor.release(c.id); return; }
  if (process.env.CORE_DEBUG) console.log(`[core] voice ${c.id} start ${Date.now()}`);
  const v = config.data.voice;
  const useKokoro = v.tts !== false && v.engine !== 'system' && !tts.failed && tts.ready;
  const p = new OrderedVoicePipeline({
    synth: useKokoro ? (t) => tts.synth(t, { voice: c.look.voice, semitones: c.look.semitones, speed: v.speed }) : null,
    forward: (item) => toClone(c, 'speak:item', item),
    onError: () => {},
  });
  p.push({ type: 'say', text });
  p.push({ type: 'end' });
  // If the helper never reports back (no voice at all), free the floor anyway.
  c.floorTimer = setTimeout(() => floor.release(c.id), 20_000);
}

function mergeClone(id) {
  const c = clones.get(id);
  if (!c || c.merging) return;
  c.merging = true;
  clearTimeout(c.mergeTimer);
  clearTimeout(c.floorTimer);
  c.ac.abort();
  if (floor) floor.release(id);
  const d = primaryDisplay();
  const to = { x: d.bounds.x + orbBounds.x, y: d.bounds.y + orbBounds.y };
  toClone(c, 'speech:stop');
  animateWindow(c.win, c.slot, to, 700, () => {
    toClone(c, 'dissolve');
    toOverlay('speak:item', { type: 'gesture', name: 'gesture', gesture: 'merge' });
    setTimeout(() => { if (c.win && !c.win.isDestroyed()) c.win.destroy(); }, 600);
  });
}

// Helpers still working: stop their brain processes, or they'd outlive COre.
function stopHelpers() {
  for (const c of clones.values()) {
    try { c.ac.abort(); } catch {}
    if (c.brain) for (const p of c.brain.chain) if (p.dispose) p.dispose();
  }
}

function mergeAllClones() {
  for (const id of [...clones.keys()]) mergeClone(id);
}

function cloneFrom(e) {
  for (const c of clones.values()) if (c.win && !c.win.isDestroyed() && e.sender === c.win.webContents) return c;
  return null;
}

function cloneConfig(c) {
  const { orb, voice } = config.data;
  return {
    // Helpers are small: fewer particles, lower resolution, light buffers.
    orb: { ...orb, radius: c.r, home: null, particles: Math.min(orb.particles || 24000, 4000), renderScale: Math.min(orb.renderScale || 1, 0.7), idleFps: Math.min(orb.idleFps || 30, 10), maxFps: 30, lite: true },
    voice: { ...voice, tts: voice.tts !== false, semitones: c.look.semitones },
    lightTheme: !nativeTheme.shouldUseDarkColors,
    view: { w: CLONE_WIN, h: CLONE_WIN },
    stage: { x: 0, y: 0, w: CLONE_WIN, h: CLONE_WIN },
    defaultHome: { x: CLONE_WIN / 2, y: CLONE_WIN / 2 },
    clone: { id: c.id, tint: c.look.tint },
    speaker: { name: c.name, color: c.look.color, show: true }, // subtitles say who is talking
  };
}

// Helpers are click-through except over their smoke (polled with COre's own hit test).
function cloneHitTest(p) {
  for (const c of clones.values()) {
    if (!c.win || c.win.isDestroyed() || !c.slot) continue;
    const b = c.win.getBounds();
    const over = Math.hypot(p.x - (b.x + b.width / 2), p.y - (b.y + b.height / 2)) < c.r * 1.45;
    if (over !== !!c.interactive) {
      c.interactive = over;
      c.win.setIgnoreMouseEvents(!over, { forward: true });
      toClone(c, 'hover', over);
    }
  }
}

// ---------------------------------------------------------------- screen partner (watch mode)

let watch = null;
function offerLook(title) {
  const id = require('crypto').randomUUID();
  actions.set(id, { kind: 'look', value: title });
  while (actions.size > 30) actions.delete(actions.keys().next().value);
  toOverlay('attention', { level: 'warn', title });
  addTranscript('system', `👀 "${title}" just popped up.`);
  toDock('dock:action', { id, kind: 'look', label: 'Take a look' });
  if (config.data.watch && config.data.watch.speak !== false && !current && !listening && !mainSpeaking) {
    speakLine('Something just popped up that looks like a problem. Want me to take a look? It is in the chat.');
  }
}

function startWatch() {
  watch = new ScreenWatch({
    listTitles: openWindowTitles,
    onProblem: offerLook,
    getConfig: () => config.data.watch || {},
    isQuiet: () => !current && !listening && !orbHidden,
  });
  watch.start();
}

// ---------------------------------------------------------------- presence

const REACTIONS = {
  pet: ['That is surprisingly pleasant.', 'Careful. I could get used to this.', 'Mm. Acceptable.', 'You do know I am made of smoke, right?'],
  tickle: ['Stop that. I am a serious machine.', 'Hey! That tickles. Somehow.', 'This is beneath my dignity. Do it again.'],
  poke: ['Yes? I am right here.', 'Poking the smoke. Bold strategy.', 'Ow. Metaphorically.'],
  toss: ['Wheee. I mean, how dare you.', 'I was not built for flight. Clearly I was.', 'Ten out of ten landing.'],
};

function onInteraction(kind) {
  if (presence) presence.noteInteraction();
  const now = Date.now();
  if (config.data.presence && config.data.presence.reactions === false) return;
  if (current || listening || now - lastReaction < 90_000 || Math.random() > 0.45) return;
  const lines = REACTIONS[kind];
  if (!lines) return;
  lastReaction = now;
  setTimeout(() => { if (!current && !listening) speakLine(lines[Math.floor(Math.random() * lines.length)]); }, 700);
}

async function startChitchat({ quietMinutes }) {
  let windows = [];
  try { windows = await openWindowTitles(); } catch {}
  const prompt = chitchatPrompt({ quietMinutes, windows, hasMemory: !!(memory && memory.list().length) });
  handleUserText(prompt, { internal: true });
}

function startPresence() {
  presence = new Presence({
    getConfig: () => config.data.presence || {},
    idleSec: () => { try { return powerMonitor.getSystemIdleTime(); } catch { return 0; } },
    isBusy: () => !!current || !!listening || !brain,
    isHidden: () => orbHidden,
    store: state,
    onChat: startChitchat,
  });
  presence.start();
}

function playGame(name) {
  const games = {
    trivia: 'Let us play trivia. Ask me one question at a time and keep score.',
    riddle: 'Give me a riddle. Let me guess before you tell me the answer.',
    twenty: 'Let us play 20 questions. You think of something and I will ask yes or no questions.',
  };
  if (games[name]) handleUserText(games[name]);
}

// internal: COre speaking up on its own (chit-chat): the prompt isn't shown
// as something the user said.
// chain: a follow-up turn right after the previous one (skill results): the
// previous reply keeps speaking and this one queues after it.
async function handleUserText(text, { withScreen = false, typed = false, internal = false, chain = 0, remote = false, files = [], playbook = null } = {}) {
  text = String(text || '').trim();
  if (!text) return;
  // Meiosis routing: decide the recipient before touching Prime's turn, so
  // talking to a specialist never interrupts what COre itself is saying.
  if (!internal && !chain) {
    if (/^\/do\s+\S/i.test(text)) { startAgent(text.replace(/^\/do\s+/i, '').slice(0, 500), { remote }); return; }
    if (agentRunner && agentRunner.running && typed) stopAgent('you sent a message');
    if (/^\/clone\s+\S/i.test(text)) { delegate(null, text.replace(/^\/clone\s+/i, '')); return; }
    if (/^\/skills?\b/i.test(text) && playbookCommand(text, { files })) return;
    if (/^\/(center|command|status)\s*$/i.test(text)) { openCommandCenter(); return; }
    // /stop or /merge, optionally for named cores: "/stop @Scout", "/merge @Forge @Sentinel".
    const ctl = /^\/(stop|merge)\b\s*(.*)$/i.exec(text);
    if (ctl) {
      const who = CORES.parseMentions(cores, ctl[2]).targets.filter((t) => t !== 'prime');
      const ids = who.length ? who : [...clones.keys()];
      if (ctl[1].toLowerCase() === 'stop') {
        if (!who.length) { abortCurrent(); toOverlay('speech:stop'); }
        for (const id of ids) { const c = clones.get(id); if (c) { try { c.ac.abort(); } catch {} toClone(c, 'speech:stop'); } }
        addTranscript('system', who.length ? `Stopped ${who.map((id) => coreById(id).name).join(', ')}.` : 'Stopped.', { kind: 'progress' });
      } else {
        for (const id of ids) mergeClone(id);
      }
      return;
    }
    const route = CORES.parseMentions(cores, text, { spoken: !typed });
    if (route.unknown.length) {
      addTranscript('user', text);
      const known = cores.map((c) => `@${c.name}`).join(', ');
      addTranscript('system', `I don't know ${route.unknown.map((u) => `@${u}`).join(', ')}. You can talk to ${known}.`, { kind: 'error' });
      return;
    }
    const specialists = route.targets.filter((t) => t !== 'prime');
    if (specialists.length) {
      if (presence) presence.noteInteraction();
      if (!route.text) {
        // Just a name: bring them up and point the chat at them.
        addTranscript('user', text, { to: route.targets });
        for (const id of specialists) ensureHelper(id);
        toDock('dock:recipient', specialists[0]);
        return;
      }
      addTranscript('user', text, { to: route.targets });
      if (route.targets.length === 1) askCore(specialists[0], route.text);
      else runSharedTask(route.targets, route.text);
      return;
    }
    if (route.targets.includes('prime')) text = route.text || text; // "@COre explain this"
  }
  if (!internal && !chain && !withScreen && !files.length && !playbook) {
    // Instant answers for short requests (time, music keys, lyrics card).
    const busyBefore = !!current;
    if (quickReply(text, { typed })) { if (!busyBefore) toOverlay('state', 'idle'); return; }
  }
  if (chain) {
    if (syncTurn && syncTurn.finished) toDock('dock:done', { text: syncTurn.reply });
    syncTurn = null;
    currentPipeline = null; // let it finish speaking
  } else {
    abortCurrent();
    toOverlay('speech:stop');
  }
  const mySkills = [];
  turnSkills = mySkills;
  turnVia = internal ? 'COre' : typed ? 'chat' : 'voice';
  if (typed || internal) followUpPending = false;
  const fileCtx = files.length ? fileShelf().contextFor(files) : null;
  if (!internal) {
    addTranscript('user', text, fileCtx ? { files: fileCtx.names } : {});
    if (presence) presence.noteInteraction();
    stopCloneSpeech(); // the user talking to COre interrupts a specialist; COre's own turns don't
    autoCapture(text);
  }
  if (!brain) {
    addTranscript('system', 'No brain is configured. Open Settings and check brain.provider.');
    toOverlay('attention', { level: 'urgent', title: 'No brain configured' });
    return;
  }

  // Never from the phone: a screenshot needs someone at the PC.
  const share = !remote && (withScreen || (config.data.screen.autoShareOnDeixis && DEIXIS.test(text)));
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
      const mem = await memory.contextForAsync(text);
      if (mem) contextBlocks.push(mem);
    }
    if (fileCtx) {
      contextBlocks.push(fileCtx.block);
      if (fileCtx.image && !shot) shot = fileImageShot(fileCtx.image, fileCtx.imageName);
      if (fileCtx.flags.length) toolAudit({ guard: 'injection-suspected', source: `files ${fileCtx.names.join(', ')}`, flags: fileCtx.flags });
    }
    { const work = coreResultsFor('prime', text); if (work) contextBlocks.push(work); }
    if (playbook) contextBlocks.push(PB.skillBlock(playbook));
    else if (playbooksOn() && playbooks.length && !internal) {
      for (const s of PB.matchSkills(playbooks, text)) contextBlocks.push(PB.skillBlock(s));
    }
    // The playbook list costs tokens every turn: only when the user talks about skills.
    if (playbooksOn() && playbooks.length && /\b(skills?|playbooks?|how-?tos?|workflows?|routines?)\b/i.test(text)) { const cat = PB.catalog(playbooks); if (cat) contextBlocks.push(cat); }
    if (plugins.length) contextBlocks.push(`[Skills] Extra skills you can use with the do tag (do NAME QUERY): ${plugins.map((p) => `${p.name} (${p.description || 'opens a link'})`).join(', ')}`);
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
  const turnStart = Date.now();
  let firstTextAt = 0;
  timingTurnStart = turnStart;
  const speak = !typed || config.data.voice.speakTyped !== false;
  const pipeline = makeVoicePipeline({ speak });
  currentPipeline = pipeline;
  const synced = speak && config.data.voice.tts !== false; // text follows the voice, typed or spoken
  const turnSync = synced ? { spokenAny: false, finished: false, reply: '' } : null;
  syncTurn = turnSync;
  toDock('dock:busy', true);
  toDock('dock:message', { role: 'core-start' });
  try {
    const { reply, truncated, error: cutReason, decision } = await brain.ask({
      text,
      shot,
      typed,
      decide: !internal && !remote,
      hasFiles: !!fileCtx,
      agentEnabled: !!(config.data.agent || {}).enabled,
      context: contextBlocks.join('\n\n'),
      signal: ac.signal,
      onText: (t) => {
        if (!firstTextAt) { firstTextAt = Date.now(); if (process.env.CORE_DEBUG) console.log(`[core] timing first-text ${firstTextAt - turnStart}ms`); }
        if (!ac.signal.aborted && !turnSync) toDock('dock:delta', t);
      },
      onItem: (item) => {
        if (ac.signal.aborted) return;
        if (process.env.CORE_DEBUG && item.type !== 'say') console.log('[core] item', JSON.stringify(item));
        if (item.type === 'gesture' && item.name === 'point') {
          if (!shot || !shot.canPoint) return; // nothing real to point at on this monitor
          let { x, y } = item;
          try { if (shot.bitmap) ({ x, y } = refinePoint(shot.bitmap(), x, y)); } catch {}
          if (process.env.CORE_DEBUG) console.log(`[core] point model=${item.x},${item.y} refined=${x},${y} shot=${shot.width}x${shot.height}`);
          pipeline.push({ ...item, ...mapPoint(shot, x, y) });
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
    if (decision) toolAudit({ event: 'route', task: decision.task, complexity: decision.complexity, effort: decision.effort, specialist: decision.specialist, source: decision.source, ms: decision.ms, provider: (brain.lastRoute || {}).provider, model: (brain.lastRoute || {}).model });
    if (reply) offerProposals(reply, 'prime');
    if (truncated) {
      // The brain dropped mid-answer: keep what was said, say so, offer to continue.
      const id = require('crypto').randomUUID();
      actions.set(id, { kind: 'continue', value: '' });
      addTranscript('system', `My answer was cut off (${cutReason}).`);
      toDock('dock:action', { id, kind: 'continue', label: 'Continue the answer' });
    }
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
    // Lookups the reply asked for (weather, notes, calendar): let COre answer with them.
    if (mySkills.length && chain < 2) {
      const results = (await Promise.all(mySkills)).filter(Boolean);
      if (results.length && current === ac && !ac.signal.aborted) {
        current = null;
        handleUserText(`[skill] ${results.join('\n')}`, { internal: true, chain: chain + 1, typed });
        return;
      }
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

// extra: { hold } hold-to-talk (ends when released), { followUp } conversation
// mode (gives up quietly after a few seconds), { wake } woken by "Hey COre".
function startListening(withScreen, extra = {}) {
  if (presence) presence.noteInteraction();
  if (orbHidden) toggleOrb(); // you can't talk to smoke you can't see
  if (listening) {
    toOverlay('listen:stop'); // second press: stop and send what we have
    return;
  }
  abortCurrent();
  toOverlay('speech:stop');
  stopCloneSpeech();
  listening = { withScreen };
  stt.warm();
  const hold = !!extra.hold || (!extra.followUp && !extra.wake && config.data.voice.talkMode === 'toggle');
  toOverlay('listen:start', { withScreen, ...extra, hold });
}

function trayTooltip() {
  if (!tray) return;
  const hk = prettyKey(config.data.hotkeys.hide);
  tray.setToolTip(orbHidden ? `COre (hidden — ${hk} to show)` : config.data.voice.wakeWord ? 'COre · listening for "Hey COre"' : 'COre');
}

function setHandsFree(on) {
  config.data.voice.wakeWord = !!on;
  config.save();
  if (on) stt.warm();
  toOverlay('config', overlayConfig());
  addTranscript('system', on
    ? 'Hands-free is on: say "Hey COre" any time. It is detected on this PC; nothing is sent anywhere until you talk to me.'
    : 'Hands-free is off. The microphone only opens when you press the talk key.');
  if (tray) { createTrayMenu(); trayTooltip(); }
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
  bind(hk.listen, () => { followCursorDisplay(); startListening(false); }, 'talk');
  bind(hk.listenWithScreen, () => { followCursorDisplay(); startListening(true); }, 'talk about screen');
  bind(hk.panel, () => { followCursorDisplay(); toggleDock(); }, 'chat');
  bind(hk.hide, toggleOrb, 'hide orb');
  bind(hk.emergency, () => emergencyStop('you pressed the emergency hotkey'), 'emergency stop');
}

// ---------------------------------------------------------------- IPC

function wireIpc() {
  // Sender checks must survive messages that arrive while a window is being
  // destroyed (restart, quit): touching a destroyed window's webContents throws.
  const isFrom = (win, e) => !!win && !win.isDestroyed() && e.sender === win.webContents;
  const fromOverlay = (e) => isFrom(overlay, e);
  const fromPanel = (e) => isFrom(panel, e);

  ipcMain.on('orb:bounds', (e, b) => {
    if (!fromOverlay(e) || !b) return;
    orbBounds = { x: +b.x || 0, y: +b.y || 0, r: Math.max(8, +b.r || 46) };
  });
  ipcMain.on('orb:drag', (e, dragging) => {
    if (!fromOverlay(e)) return;
    orbDragging = !!dragging;
    if (process.env.CORE_DEBUG) console.log(`[core] drag=${orbDragging} dockVisible=${dockVisible} orbHidden=${orbHidden}`);
    // Moving two transparent windows together every frame flickers on
    // Windows: hide the chat while dragging, bring it back on drop.
    if (dock && dockVisible && !orbHidden) {
      if (orbDragging) dock.hide();
      else setTimeout(() => {
        if (!orbDragging && dockVisible && !orbHidden) { positionDock(); dock.showInactive(); }
        if (process.env.CORE_DEBUG) console.log(`[core] dock shown again: ${dock.isVisible()}`);
      }, 120);
    }
  });
  ipcMain.on('stage:need', (e, r) => {
    if (!fromOverlay(e) || !r || ![r.x, r.y, r.w, r.h].every(Number.isFinite)) return;
    applyStage(r);
  });
  ipcMain.on('orb:click', (e) => { if (fromOverlay(e)) { toggleDock(); if (presence) presence.noteInteraction(); } });
  ipcMain.handle('clone:init', (e) => { const c = cloneFrom(e); return c ? cloneConfig(c) : null; });
  ipcMain.on('clone:idle', (e) => {
    const c = cloneFrom(e);
    if (c && process.env.CORE_DEBUG) console.log(`[core] voice ${c.id} end ${Date.now()}`);
    if (c && floor && floor.holder === c.id) { clearTimeout(c.floorTimer); floor.release(c.id); }
  });
  // Click a specialist to talk to it; poke it (double click) to merge it back.
  ipcMain.on('clone:click', (e) => {
    const c = cloneFrom(e);
    if (!c) return;
    setDockVisible(true, true);
    toDock('dock:recipient', c.id);
  });
  // Drag a specialist by its orb: the window follows; where you drop it, it stays.
  ipcMain.on('clone:drag', (e, d = {}) => {
    const c = cloneFrom(e);
    if (!c || !c.win || c.win.isDestroyed() || c.merging) return;
    if (d.phase === 'start') { const [x, y] = c.win.getPosition(); c.dragFrom = { x, y }; return; }
    if (d.phase === 'end') { c.dragFrom = null; return; }
    if (!c.dragFrom || !Number.isFinite(+d.dx) || !Number.isFinite(+d.dy)) return;
    const wa = screen.getDisplayMatching(c.win.getBounds()).workArea;
    const x = Math.round(Math.min(Math.max(c.dragFrom.x + Number(d.dx), wa.x - CLONE_WIN / 3), wa.x + wa.width - CLONE_WIN * 2 / 3));
    const y = Math.round(Math.min(Math.max(c.dragFrom.y + Number(d.dy), wa.y - CLONE_WIN / 3), wa.y + wa.height - CLONE_WIN * 2 / 3));
    c.win.setPosition(x, y);
    c.slot = { x: x + CLONE_WIN / 2, y: y + CLONE_WIN / 2 };
  });
  ipcMain.on('clone:interaction', (e, kind) => { const c = cloneFrom(e); if (c && kind === 'poke') mergeClone(c.id); });
  ipcMain.on('orb:interaction', (e, kind) => { if (fromOverlay(e) && ['pet', 'tickle', 'poke', 'toss'].includes(kind)) onInteraction(kind); });
  ipcMain.on('orb:anchor', (e, a) => {
    if (!fromOverlay(e) || !a) return;
    dockAnchor = { x: +a.x || 0, y: +a.y || 0, r: Math.max(8, +a.r || 60) };
    if (dockVisible) positionDock();
  });

  const fromDock = (e) => isFrom(dock, e);
  ipcMain.handle('dock:init', (e) => (fromDock(e) ? {
    settings: dockSettings(),
    // Recent conversation, plus notices from this session (the dock may load
    // after startup notices like "log in to Claude" were raised).
    recent: transcript.slice(-12)
      .filter((m) => m.role !== 'system' || m.ts >= APP_STARTED)
      .slice(-8)
      .map((m) => ({ role: m.role === 'notice' ? 'system' : m.role, text: m.text, author: m.author, kind: m.kind, to: m.to })),
    cores: coresForUi(),
  } : null));
  ipcMain.on('dock:ask', (e, payload) => {
    if (!fromDock(e)) return;
    const { text, files } = typeof payload === 'string' ? { text: payload } : (payload || {});
    handleUserText(String(text || ''), { typed: true, files: Array.isArray(files) ? files.slice(0, 10).map(String) : [] });
  });
  const fromCenter = (e) => isFrom(centerWin, e);
  ipcMain.handle('center:state', (e) => (fromCenter(e) ? centerState() : null));
  ipcMain.handle('center:action', (e, { name, arg } = {}) => (fromCenter(e) ? centerAction(String(name || ''), arg == null ? '' : String(arg)) : null));
  ipcMain.on('center:close', (e) => { if (fromCenter(e)) centerWin.close(); });
  ipcMain.on('dock:openCenter', (e) => { if (fromDock(e)) openCommandCenter(); });
  ipcMain.handle('dock:files', (e) => (fromDock(e) ? fileShelf().list() : []));
  ipcMain.handle('dock:filesAdd', (e, paths) => (fromDock(e) && Array.isArray(paths) ? addFiles(paths.filter((p) => typeof p === 'string' && path.isAbsolute(p))) : []));
  ipcMain.on('dock:filesMedia', (e, { id, ...rest } = {}) => { if (fromDock(e)) fileMedia(id, rest); });
  ipcMain.on('dock:filesRemove', (e, id) => { if (fromDock(e)) { fileShelf().remove(String(id)); sendFiles(); } });
  ipcMain.on('dock:stop', (e) => { if (fromDock(e)) { abortCurrent(); toOverlay('speech:stop'); cancelHelpers(); } });
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
  ipcMain.on('dock:proposal', (e, { id, action } = {}) => {
    if (!fromDock(e)) return;
    const cm = changeManager();
    try {
      if (action === 'apply') {
        const ch = cm.apply(String(id));
        const who = coreById(ch.core) ? coreById(ch.core).name : 'COre';
        addTranscript('system', `${who}'s change applied: ${ch.rel} (${ch.isNew ? 'new file' : `+${ch.added} −${ch.removed}`}).`, { author: ch.core, kind: 'progress' });
        toDock('dock:proposal-update', { id, state: 'applied' });
      } else if (action === 'reject') {
        cm.reject(String(id));
        toDock('dock:proposal-update', { id, state: 'rejected' });
      } else if (action === 'undo') {
        const ch = cm.undo(String(id));
        addTranscript('system', `Undid the change to ${ch.rel}.`, { author: ch.core, kind: 'progress' });
        toDock('dock:proposal-update', { id, state: 'undone' });
      }
    } catch (err) {
      addTranscript('system', err.message, { kind: 'error' });
      toDock('dock:proposal-update', { id, state: 'error', message: err.message });
    }
  });
  // Floating bubbles: clicks in the gaps go through to the app below.
  ipcMain.on('dock:interactive', (e, v) => {
    if (!fromDock(e) || !['win32', 'darwin'].includes(process.platform)) return;
    dock.setIgnoreMouseEvents(!v, { forward: true });
  });
  ipcMain.on('dock:openSettings', (e) => { if (fromDock(e)) openSettings(); });
  const fromSettings = (e) => isFrom(settingsWin, e);
  ipcMain.handle('settings:load', (e) => (fromSettings(e) ? { sections: SCHEMA.SECTIONS, values: settingsValues(), secrets: settingsSecrets(), version: app.getVersion() } : null));
  ipcMain.handle('settings:set', (e, { key, value } = {}) => (fromSettings(e) ? changeSetting(String(key), value) : { ok: false }));
  ipcMain.on('dock:agent-answer', (e, { id, answer } = {}) => {
    if (!fromDock(e)) return;
    if (id === 'stop') { stopAgent('you pressed Stop'); return; }
    const a = agentApprovals.get(String(id));
    if (!a) return;
    agentApprovals.delete(String(id));
    a.resolve(['yes', 'all', 'no'].includes(answer) ? answer : 'no');
  });
  ipcMain.handle('settings:action', (e, name) => (fromSettings(e) ? settingsAction(String(name)) : null));
  ipcMain.on('settings:close', (e) => { if (fromSettings(e)) settingsWin.close(); });
  ipcMain.handle('dock:memory', (e) => (fromDock(e) && memory ? memory.list() : []));
  ipcMain.on('dock:memoryPin', (e, { id, on } = {}) => { if (fromDock(e) && memory) { memory.pin(String(id), !!on); toDock('dock:memory', memory.list()); } });
  ipcMain.on('dock:memoryEdit', (e, { id, text } = {}) => { if (fromDock(e) && memory) { memory.edit(String(id), String(text || '')); toDock('dock:memory', memory.list()); } });
  ipcMain.on('dock:memoryForget', (e, id) => { if (fromDock(e) && memory) { const gone = memory.forget(String(id)); if (gone) noteMemoryRemoved(gone.text); toDock('dock:memory', memory.list()); } });
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
      followUpPending = config.data.voice.followUp === true;
      await handleUserText(text, { withScreen });
    } catch (err) {
      addTranscript('system', `Speech recognition failed: ${err.message}. You can type in the chat panel instead.`);
      toOverlay('attention', { level: 'warn', title: 'Could not hear you' });
      toOverlay('state', 'idle');
    }
  });
  // Hands-free: a short phrase heard after a pause; is it "Hey COre"?
  let wakeChecking = false;
  ipcMain.on('wake:check', async (e, audio) => {
    if (!fromOverlay(e) || !config.data.voice.wakeWord || wakeChecking || listening || current) { if (fromOverlay(e)) toOverlay('wake:result', false); return; }
    wakeChecking = true;
    let hit = null;
    try {
      const pcm = audio instanceof Float32Array ? audio : new Float32Array(audio);
      hit = matchWake(await stt.transcribe(pcm));
    } catch (err) {
      console.warn('[core] wake check failed:', err.message);
    } finally {
      wakeChecking = false;
    }
    toOverlay('wake:result', !!hit);
    if (!hit || listening || current) return;
    if (presence) presence.noteInteraction();
    if (hit.rest.split(/\s+/).length >= 2) {
      // "Hey COre, what's the weather like" - the question came with it.
      followUpPending = config.data.voice.followUp === true;
      handleUserText(hit.rest);
    } else {
      startListening(false, { wake: true });
    }
  });
  ipcMain.on('voice:bargein', (e) => {
    if (!fromOverlay(e)) return;
    abortCurrent();
    startListening(false, { wake: true });
  });
  ipcMain.on('listen:hold', (e, on) => {
    if (!fromOverlay(e)) return;
    if (on && !listening) startListening(false, { hold: true });
    else if (!on && listening) toOverlay('listen:stop');
  });
  ipcMain.on('listen:cancelled', (e, reason) => {
    if (!fromOverlay(e)) return;
    listening = null;
    if (reason && reason !== 'silence') addTranscript('system', `Microphone: ${reason}`);
  });
  ipcMain.on('overlay:log', (e, msg) => { if (fromOverlay(e)) console.log('[overlay]', msg); });
  ipcMain.on('voice:spoken', (e, { text, ms } = {}) => {
    if (process.env.CORE_DEBUG) console.log(`[core] spoken ${Date.now()} ms=${Math.round(ms)} ${String(text).slice(0, 50)}`);
    if (!fromOverlay(e) || !syncTurn || !text) return;
    // The chat reveals this sentence word by word over its real audio length.
    toDock('dock:speak', { text: `${syncTurn.spokenAny ? ' ' : ''}${text}`, ms: Math.max(300, Math.min(30000, +ms || 0)) });
    syncTurn.spokenAny = true;
  });
  ipcMain.on('voice:idle', (e) => {
    if (fromOverlay(e)) mainSpeaking = false;
    if (fromOverlay(e) && process.env.CORE_DEBUG) console.log(`[core] voice prime end ${Date.now()}`);
    if (fromOverlay(e) && followUpPending && !current && !listening) {
      followUpPending = false;
      setTimeout(() => { if (!current && !listening) startListening(false, { followUp: true }); }, 250);
    }
    if (!fromOverlay(e) || !syncTurn || !syncTurn.finished) return;
    toDock('dock:done', { text: syncTurn.reply });
    syncTurn = null;
  });
  // The orb drew its first frame: graphics are fine, so now load the voice
  // (loading it earlier could collide with a safe-graphics restart).
  ipcMain.once('overlay:ready', (e) => {
    if (!fromOverlay(e)) return;
    pushRenderMode(true);
    if (smoke) { smoke.mark('overlay-ready'); return; }
    // COre started fine after an update: the update is good, stop watching it.
    if (state.get('updateVerify')) { state.set('updateVerify', null); state.flush(); }
    const rb = state.get('updateRolledBack');
    if (rb) {
      state.set('updateRolledBack', null);
      addTranscript('system', `The update to v${rb.from} didn't start properly, so I went back to v${rb.to}. Your settings and memory are untouched. Diagnostics are in the crash log (Settings → Maintenance).`);
    }
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
    crashLog.record('webgl', msg);
    if (smoke) { smoke.mark('overlay-ready', false, String(msg)); return; }
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
    stopHelpers();
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
  if (SMOKE) return; // a self-test reports problems instead of restarting
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
    recentProblems: crashLog.recent(5),
    brainHealth: brain ? brain.health() : [],
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

function relaunchAfterUpdate(version, needsInstall, install, meta) {
  if (needsInstall) state.set('pendingInstall', true);
  // Source updates: watch the next starts; if the new version can't start,
  // the backup of the old one is restored automatically (see checkUpdateHealth).
  if (meta && meta.backup) state.set('updateVerify', { version, from: meta.from, backup: meta.backup, boots: 0 });
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
    setTimeout(() => {
      if (!install) return restartApp();
      app.isQuitting = true;
      install();
    }, 4500);
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

// After a source update, count starts that never reached the first frame.
// Two failed starts in a row: restore the previous version and restart.
// Returns true when it rolled back (the caller should stop starting up).
function checkUpdateHealth() {
  const uv = state.get('updateVerify');
  if (!uv || app.isPackaged) return false;
  if ((uv.boots || 0) < 2) {
    state.set('updateVerify', { ...uv, boots: (uv.boots || 0) + 1 });
    state.flush();
    return false;
  }
  try {
    const readPkg = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return {}; } };
    const depsDiffer = depsChanged(readPkg(ROOT), readPkg(uv.backup));
    updater.restore(uv.backup);
    crashLog.record('update-rollback', `v${uv.version} failed to start twice; restored v${uv.from}`);
    state.set('updateVerify', null);
    state.set('updateRolledBack', { from: uv.version, to: uv.from });
    // Reinstall packages only if the failed update had changed them.
    if (depsDiffer) state.set('pendingInstall', true);
    state.flush();
    app.relaunch();
    app.exit(0);
    return true;
  } catch (err) {
    crashLog.record('update-rollback-failed', err);
    state.set('updateVerify', null);
    state.flush();
    return false;
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
  transcript.push(...(state.get('transcript') || []).map((e) => ({ ...e, seq: ++transcriptSeq })));

  try {
    brain = makeBrain();
  } catch (err) {
    dialog.showErrorBox('COre', err.message);
  }
  updater = app.isPackaged
    ? new ReleaseUpdater({ getConfig: () => config.data.update, log: (msg) => addTranscript('system', msg) })
    : new Updater({ appRoot: ROOT, getConfig: () => config.data.update, log: (msg) => addTranscript('system', msg), backupDir: path.join(userData, 'update-backup') });
  if (!SMOKE && checkUpdateHealth()) return; // rolled back: restarting into the previous version
  if (!app.isPackaged && state.get('pendingInstall')) {
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
  startMemoryEngine();
  // A task cut off by a crash or quit can pick up where it stopped.
  setTimeout(() => {
    const t = readAgentTask();
    if (t && t.status === 'running' && Date.now() - (t.at || 0) < 7 * 864e5) addTranscript('system', `An agent task was interrupted at step ${t.step}: "${String(t.goal).slice(0, 80)}". Type /do resume to continue it.`);
  }, 4000);
  notes = new SK.Notes(path.join(userData, 'notes.json'));
  refreshCores();
  // Shared tasks that were running when COre stopped are marked interrupted,
  // never re-run on their own (a retry is the user's call).
  const tasks = state.get('tasks') || [];
  const interrupted = tasks.filter((t) => t.status === 'running');
  if (interrupted.length) {
    for (const t of interrupted) {
      t.status = 'interrupted';
      for (const st of t.steps || []) if (st.status === 'running' || st.status === 'pending') st.status = 'interrupted';
    }
    state.set('tasks', tasks);
    addTranscript('system', `${interrupted.length === 1 ? 'A shared task was' : `${interrupted.length} shared tasks were`} interrupted when COre closed: "${String(interrupted[0].text).slice(0, 80)}". Ask again to run it.`, { kind: 'error', author: 'prime' });
  }
  // Older versions kept the private calendar link in plain text: encrypt it.
  if (config.data.skills && config.data.skills.calendarUrl) {
    setSecret('calendar', config.data.skills.calendarUrl);
    config.data.skills.calendarUrl = '';
    config.save();
  }
  // Damaged data files were set aside, not overwritten: say where they are.
  for (const [what, p] of [['settings', config.recovered], ['window state', state.recovered], ['memory', memory.recovered], ['notes', notes.recovered]]) {
    if (p) {
      crashLog.record('data-recovered', `${what}: ${p}`);
      addTranscript('system', `Your ${what} file was damaged, so I started that part fresh. The old file is kept at ${p} if you want to recover anything.`);
    }
  }
  plugins = SK.loadPlugins(path.join(userData, 'skills'));
  PB.seedExamples(playbookDir(), path.join(__dirname, '..', '..', 'assets', 'skills'));
  reloadPlaybooks();
  watchPlaybooks();
  setTimeout(checkAutoBackup, 60_000);
  syncPhone();
  watchPower();
  setTimeout(prewarmQuickVoice, 45_000);
  scheduleDriveSync(120_000);
  setInterval(() => scheduleDriveSync(0), 3600_000).unref();
  setInterval(checkAutoBackup, 3600_000).unref();
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
    // The orb's spot may now be off-screen (monitor unplugged, resolution
    // dropped): bring it back to a visible home.
    const v = viewSize();
    if (orbBounds.x < 0 || orbBounds.y < 0 || orbBounds.x > v.w || orbBounds.y > v.h) {
      const h = homeNow();
      applyStage(initialStage());
      toOverlay('relocate', h);
      orbBounds = { ...orbBounds, x: h.x, y: h.y };
      dockAnchor = { x: h.x, y: h.y, r: orbBounds.r };
    }
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
  if (SMOKE) {
    smoke = new SmokeTest({
      target: SMOKE,
      root: ROOT,
      version: app.getVersion(),
      packaged: app.isPackaged,
      onDone: (code, report) => {
        console.log(`[core] smoke test ${report.ok ? 'passed' : 'FAILED'}${report.error ? `: ${report.error}` : ''}`);
        app.isQuitting = true;
        app.exit(code);
      },
    });
    const wc = dock.webContents;
    if (!wc.isLoading()) smoke.mark('dock-loaded');
    else {
      wc.once('did-finish-load', () => smoke.mark('dock-loaded'));
      wc.once('did-fail-load', (_e, code, desc) => smoke.mark('dock-loaded', false, `${code} ${desc}`));
    }
    return; // no updater, network services, greetings or presence in a self-test
  }
  await startNotify();
  updater.start(relaunchAfterUpdate);
  reminders.start();
  startPresence();
  startWatch();
  if (process.env.CORE_DEBUG_WATCH) setTimeout(() => offerLook(process.env.CORE_DEBUG_WATCH), 9000); // end-to-end tests
  floor = new CL.SpeechFloor({ mainBusy: () => !!current || !!listening || (mainSpeaking && Date.now() - mainSpeakingSince < 60_000) });
  setInterval(() => floor.pump(), 500);
  if (process.env.CORE_DEBUG_CHITCHAT) setTimeout(() => startChitchat({ quietMinutes: 30 }), 9000); // end-to-end tests
  if (!state.get('onboarded')) setTimeout(runTour, 4500); // first run: show COre around
  else setTimeout(greetIfFirstToday, 3500);

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
  stopGlanceReader();
  if (companion) companion.stop();
  stopAgent('quitting');
  try { if (playbookScheduler) playbookScheduler.stop(); if (playbookWatch) playbookWatch.close(); } catch {}
  if (embedder) embedder.dispose();
  globalShortcut.unregisterAll();
  clearInterval(cursorTimer);
  if (!restarting) {
    if (stt) stt.dispose();
    if (tts) tts.dispose();
  }
  if (updater) updater.stop();
  if (reminders) reminders.stop();
  if (brain) for (const p of brain.chain) if (p.dispose) p.dispose();
  stopHelpers();
  if (state) state.flush();
});

app.on('window-all-closed', (e) => e.preventDefault());

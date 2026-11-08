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

const IS_LINUX = process.platform === 'linux';
const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PRELOAD = path.join(ROOT, 'src', 'preload');

// The orb is a WebGL2 shader. Some GPUs/VMs are blocklisted by Chromium,
// which would leave COre invisible; fall back to software GL instead.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

// Transparent windows on Linux need these to composite correctly.
if (IS_LINUX) {
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
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
let ttsWarned = false;
let tray = null;
let current = null; // AbortController of the running turn
let listening = null; // { withScreen }
let orbBounds = { x: 0, y: 0, r: 60 };
let orbDragging = false;
let overlayInteractive = false;
let cursorTimer = null;
let workDir;
let lastShot = null;

const transcript = [];
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
  if (!overlay || overlay.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const b = primaryDisplay().bounds; // orbBounds are display coordinates
  const dx = p.x - b.x - orbBounds.x;
  const dy = p.y - b.y - orbBounds.y;
  const over = orbDragging || Math.hypot(dx, dy) < orbBounds.r * 1.15;
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
    { type: 'separator' },
    { label: 'Quit COre', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => togglePanel());
}

let orbHidden = false;
function toggleOrb() {
  if (!overlay) return;
  orbHidden = !orbHidden;
  if (orbHidden) {
    overlay.hide();
    if (dock && dock.isVisible()) dock.hide();
    const key = prettyKey(config.data.hotkeys.hide);
    // Make it obvious COre was hidden on purpose, and how to get it back.
    if (Notification.isSupported()) {
      new Notification({ title: 'COre is hidden', body: `Press ${key} (or use the tray icon) to bring COre back.`, silent: true }).show();
    }
    if (tray) tray.setToolTip(`COre (hidden — ${key} to show)`);
  } else {
    overlay.showInactive();
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
  addTranscript('system', 'Settings reloaded.');
}

function overlayConfig() {
  const { orb, voice } = config.data;
  return {
    orb,
    voice: { ...voice, tts: voice.tts !== false },
    lightTheme: !nativeTheme.shouldUseDarkColors,
    view: viewSize(),
    stage,
    defaultHome: defaultHome(),
  };
}

// ---------------------------------------------------------------- screen

async function captureScreen() {
  const d = primaryDisplay();
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
  const png = img.toPNG();

  const dir = path.join(workDir, 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `shot-${Date.now()}.png`);
  fs.writeFileSync(file, png);
  // keep only the latest few screenshots
  const old = fs.readdirSync(dir).filter((f) => f.startsWith('shot-')).sort().slice(0, -5);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });

  return {
    path: file,
    width: size.width,
    height: size.height,
    base64: png.toString('base64'),
    displayWidth: width,
    displayHeight: height,
  };
}

function mapPoint(shot, x, y) {
  return {
    x: Math.round((x / shot.width) * shot.displayWidth),
    y: Math.round((y / shot.height) * shot.displayHeight),
  };
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
  toDock('dock:done', {});
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

  const ac = new AbortController();
  current = ac;
  const speak = !typed || config.data.voice.speakTyped !== false;
  const pipeline = makeVoicePipeline({ speak });
  currentPipeline = pipeline;
  toDock('dock:busy', true);
  toDock('dock:message', { role: 'core-start' });
  try {
    const { reply } = await brain.ask({
      text,
      shot,
      typed,
      signal: ac.signal,
      onText: (t) => { if (!ac.signal.aborted) toDock('dock:delta', t); },
      onItem: (item) => {
        if (ac.signal.aborted) return;
        if (item.type === 'gesture' && item.name === 'point') {
          if (!shot) return; // no screenshot: nothing real to point at
          pipeline.push({ ...item, ...mapPoint(shot, item.x, item.y) });
          return;
        }
        pipeline.push(item);
      },
      onStatus: (s) => {
        toPanel('status', s);
        if (s.kind === 'fallback') addTranscript('system', `${s.from} failed: ${s.reason} Switching to ${s.to}.`);
      },
    });
    if (reply) addTranscript('core', reply);
    toDock('dock:done', { text: reply });
  } catch (err) {
    toDock('dock:done', {});
    if (err.aborted) return;
    addTranscript('system', err.message);
    toOverlay('attention', { level: 'urgent', title: 'COre could not answer' });
    speakLine("I can't reach my brain right now. The chat says why.");
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
    recent: transcript.slice(-8).filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'notice' ? 'system' : m.role, text: m.text })),
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
  ipcMain.on('orb:home', (e, home) => {
    if (!fromOverlay(e) || !home) return;
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
    require('electron').clipboard.writeText(config.data.notify.token);
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

// ---------------------------------------------------------------- updates

function relaunchAfterUpdate(version, needsInstall) {
  if (needsInstall) state.set('pendingInstall', true);
  state.flush();
  toOverlay('attention', { level: 'info', title: 'COre updated' });
  speakLine(`Upgrade complete. Version ${version}. Try to contain your excitement.`);
  setTimeout(() => {
    app.isQuitting = true;
    app.relaunch();
    app.exit(0);
  }, 4500);
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
    onProgress: (p) => {
      toPanel('status', { kind: 'download', file: `voice ${p.file}`, pct: p.pct });
      if (!voiceNoticeShown && !fs.existsSync(path.join(userData, 'models', 'onnx-community', 'Kokoro-82M-v1.0-ONNX'))) {
        voiceNoticeShown = true;
        addTranscript('system', 'Downloading my voice (one time, about 90 MB). I will use your system voice until it is ready.');
      }
    },
  });
  if (config.data.voice.engine !== 'system' && config.data.voice.tts !== false) tts.warm();
  dockVisible = state.get('dockVisible') !== false;

  // Only COre's own overlay may use the microphone.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media' && overlay && wc === overlay.webContents);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => (
    permission === 'media' && !!overlay && wc === overlay.webContents
  ));

  wireIpc();
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

  const hk = config.data.hotkeys;
  if (!transcript.length) {
    addTranscript('system', `Hi, I'm COre. Press ${prettyKey(hk.listen)} to talk, ${prettyKey(hk.listenWithScreen)} to talk about your screen, or type in the chat under me. Brain: ${brainStatus().primary}.`);
  }

  refreshBrainStatus().then((list) => {
    const claude = list.find((p) => p.id === 'claude-cli');
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
  if (stt) stt.dispose();
  if (tts) tts.dispose();
  if (updater) updater.stop();
  if (state) state.flush();
});

app.on('window-all-closed', (e) => e.preventDefault());

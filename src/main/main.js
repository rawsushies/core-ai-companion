'use strict';

const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen,
  desktopCapturer, shell, nativeImage, session, dialog,
} = require('electron');

const { loadConfig, loadState } = require('./config');
const { Brain } = require('./brain');
const { SpeechToText } = require('./stt');
const { startNotifyServer } = require('./notifyServer');

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

let config; // JsonFile
let state;
let brain;
let stt;
let overlay = null;
let panel = null;
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

function addTranscript(role, text) {
  const entry = { role, text, ts: Date.now() };
  transcript.push(entry);
  if (transcript.length > 200) transcript.shift();
  state.set('transcript', transcript.slice(-100));
  toPanel('transcript:add', entry);
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

// ---------------------------------------------------------------- windows

function createOverlay() {
  const d = primaryDisplay();
  const { x, y, width, height } = d.bounds;
  overlay = new BrowserWindow({
    x, y, width, height,
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
    },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  if (config.data.orb.hideFromCaptures && !IS_LINUX) overlay.setContentProtection(true);
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
  const b = overlay.getBounds();
  const dx = p.x - b.x - orbBounds.x;
  const dy = p.y - b.y - orbBounds.y;
  const over = orbDragging || Math.hypot(dx, dy) < orbBounds.r * 1.15;
  if (over !== overlayInteractive) {
    overlayInteractive = over;
    overlay.setIgnoreMouseEvents(!over, { forward: true });
    toOverlay('hover', over);
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
  tray.setToolTip('COre');
  const menu = Menu.buildFromTemplate([
    { label: 'Talk to COre', click: () => startListening(false) },
    { label: 'Talk about my screen', click: () => startListening(true) },
    { label: 'Open chat panel', click: () => togglePanel(true) },
    { type: 'separator' },
    { label: 'Hide / show orb', click: toggleOrb },
    { label: 'New conversation', click: resetConversation },
    { label: 'Settings (config.json)', click: openConfig },
    { type: 'separator' },
    { label: 'Quit COre', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => togglePanel());
}

function toggleOrb() {
  if (!overlay) return;
  if (overlay.isVisible()) overlay.hide();
  else overlay.showInactive();
}

function openConfig() {
  shell.openPath(config.file);
  addTranscript('system', 'Opened config.json. Save it, then choose "Reload settings" in the panel.');
}

function reloadConfig() {
  config.reload();
  try {
    if (brain) brain.reload(config.data);
    else brain = new Brain({ config: config.data, workDir, state });
  } catch (err) {
    addTranscript('system', err.message);
  }
  stt.dispose();
  stt = makeStt();
  registerHotkeys();
  toOverlay('config', overlayConfig());
  toPanel('status', { kind: 'brain', ...brainStatus() });
  addTranscript('system', 'Settings reloaded.');
}

function overlayConfig() {
  const { orb, voice } = config.data;
  return { orb, voice };
}

// ---------------------------------------------------------------- screen

async function captureScreen() {
  const d = primaryDisplay();
  const { width, height } = d.size;
  const scale = Math.min(1, 1568 / Math.max(width, height));
  const thumbnailSize = { width: Math.round(width * scale), height: Math.round(height * scale) };

  // Linux can't exclude a window from capture, so hide the orb for a moment.
  const hide = IS_LINUX && overlay && overlay.isVisible();
  if (hide) {
    overlay.hide();
    await new Promise((r) => setTimeout(r, 140));
  }
  let sources;
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  } finally {
    if (hide) overlay.showInactive();
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
}

function resetConversation() {
  abortCurrent();
  toOverlay('speech:stop');
  if (brain) brain.resetConversation();
  transcript.length = 0;
  state.set('transcript', []);
  toPanel('transcript:reset');
  addTranscript('system', 'Started a new conversation.');
}

async function handleUserText(text, { withScreen = false } = {}) {
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
  try {
    const { reply } = await brain.ask({
      text,
      shot,
      signal: ac.signal,
      onItem: (item) => {
        if (ac.signal.aborted) return;
        if (item.type === 'gesture' && item.name === 'point') {
          if (!shot) return; // no screenshot: nothing real to point at
          toOverlay('speak:item', { ...item, ...mapPoint(shot, item.x, item.y) });
          return;
        }
        toOverlay('speak:item', item);
      },
      onStatus: (s) => {
        toPanel('status', s);
        if (s.kind === 'fallback') addTranscript('system', `${s.from} failed: ${s.reason} Switching to ${s.to}.`);
      },
    });
    if (reply) addTranscript('core', reply);
  } catch (err) {
    if (err.aborted) return;
    addTranscript('system', err.message);
    toOverlay('attention', { level: 'urgent', title: 'COre could not answer' });
    toOverlay('speak:item', { type: 'say', text: "I can't reach my brain right now. The chat panel says why." });
    toOverlay('speak:item', { type: 'end' });
  } finally {
    if (current === ac) current = null;
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

function makeStt() {
  const v = config.data.voice;
  return new SpeechToText({
    model: v.sttModel,
    language: v.sttLanguage,
    cacheDir: path.join(app.getPath('userData'), 'models'),
    onProgress: (p) => toPanel('status', { kind: 'download', file: p.file, pct: p.pct }),
  });
}

// ---------------------------------------------------------------- hotkeys

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = config.data.hotkeys;
  const bind = (accel, fn, name) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) addTranscript('system', `Hotkey ${accel} (${name}) is taken by another app.`);
    } catch (err) {
      addTranscript('system', `Invalid hotkey ${accel}: ${err.message}`);
    }
  };
  bind(hk.listen, () => startListening(false), 'talk');
  bind(hk.listenWithScreen, () => startListening(true), 'talk about screen');
  bind(hk.panel, () => togglePanel(), 'chat panel');
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
  ipcMain.on('orb:click', (e) => { if (fromOverlay(e)) togglePanel(); });
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
      hotkeys: hk,
      notify: { port: config.data.notify.port, enabled: config.data.notify.enabled },
    };
  });
  ipcMain.on('panel:ask', (e, { text, withScreen }) => { if (fromPanel(e)) handleUserText(text, { withScreen }); });
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
        if (note.speak || n.speak) {
          toOverlay('speak:item', { type: 'say', text: note.title });
          toOverlay('speak:item', { type: 'end' });
        }
      },
    });
  } catch (err) {
    addTranscript('system', `Notification endpoint could not start on port ${n.port}: ${err.message}`);
  }
}

// ---------------------------------------------------------------- app

app.on('second-instance', () => togglePanel(true));

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  config = loadConfig(userData);
  state = loadState(userData);
  workDir = path.join(userData, 'claude-workspace');
  fs.mkdirSync(path.join(workDir, 'shots'), { recursive: true });
  transcript.push(...(state.get('transcript') || []));

  try {
    brain = new Brain({ config: config.data, workDir, state });
  } catch (err) {
    dialog.showErrorBox('COre', err.message);
  }
  stt = makeStt();

  // Only COre's own overlay may use the microphone.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media' && overlay && wc === overlay.webContents);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => (
    permission === 'media' && !!overlay && wc === overlay.webContents
  ));

  wireIpc();
  // Linux compositors sometimes need a beat before a transparent window is created.
  if (IS_LINUX) await new Promise((r) => setTimeout(r, 300));
  createOverlay();
  createPanel();
  createTray();
  registerHotkeys();
  await startNotify();

  const hk = config.data.hotkeys;
  if (!transcript.length) {
    addTranscript('system', `Hi, I'm COre. Press ${hk.listen} to talk, ${hk.listenWithScreen} to talk about your screen, or ${hk.panel} to type. Brain: ${brainStatus().primary}.`);
  }

  if (brain && brain.primary.detect) {
    brain.primary.detect().catch((err) => {
      addTranscript('system', `${err.message}${brain.fallback ? ` I will use ${brain.fallback.label} until then.` : ''}`);
      toOverlay('attention', { level: 'warn', title: 'Claude Code needs setup' });
    });
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  clearInterval(cursorTimer);
  if (stt) stt.dispose();
  if (state) state.flush();
});

app.on('window-all-closed', (e) => e.preventDefault());

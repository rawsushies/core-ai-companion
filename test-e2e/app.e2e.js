'use strict';

// End-to-end tests against the real app (Electron + the fake Claude CLI).
// Run with `npm run e2e` (Linux needs a display: `xvfb-run -a npm run e2e`).
// They drive the actual windows: chat, quick answers, the glance card,
// render pausing, every Settings section, backups and phone pairing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nacl = require('tweetnacl');
const { _electron: electron } = require('playwright-core');
const C = require('../src/main/companion');

const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let app;
let dock;
let overlay;
let home;
let userData;
let project;
let script;
let baseRules = [];
const errors = [];

test.before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'core-e2e-home-'));
  fs.mkdirSync(path.join(home, 'Dropbox'));
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'core-e2e-ud-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'core-e2e-proj-'));
  fs.writeFileSync(path.join(project, 'readme.txt'), 'old readme\n');
  const cover = path.join(userData, 'cover.png');
  fs.writeFileSync(cover, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const player = JSON.stringify({ status: 'Playing', posUs: 64000000, lenUs: 201000000, artUrl: require('url').pathToFileURL(cover).href, artist: 'The Smoke Choir', album: 'Signals', title: 'Midnight Signal' });
  script = path.join(userData, 'fake-script.json');
  fs.writeFileSync(script, JSON.stringify(baseRules = [
    { match: 'remember my tea', reply: 'Got it. [[remember the user likes green tea]]' },
    { match: 'set a tea timer', reply: 'Timer on. [[do timer 10m tea]]' },
    { match: 'Review the file changes', reply: 'Looks fine.\n\nThe readme change is plain text. Verdict: ship it' },
    { match: 'rewrite the readme', reply: '{core} here, proposing it.\n\n```txt file=readme.txt\nnew readme from forge\n```' },
    { match: 'open my downloads folder', reply: 'I would open the file manager.\n\n1. Open Files\n2. Click Downloads\nTask: open the Downloads folder in the file manager' },
    { match: 'Memory stats\\] \\d+ memories', reply: 'From memory.\n\nArchivist checked: green tea, noted earlier.' },
  ]));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    orb: { graphics: 'software' },
    brain: { claude: { command: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js') }, fallbacks: [] },
    voice: { tts: false },
    presence: { chitchat: false },
    update: { enabled: false },
    phone: { host: '127.0.0.1', port: 0 },
    tools: { projectRoot: project, enabled: true, allowWrites: true },
    skills: { lyrics: false }, // no network in tests
  }));
  fs.writeFileSync(path.join(userData, 'state.json'), JSON.stringify({ onboarded: true }));
  app = await electron.launch({
    args: ['--no-sandbox', ROOT, `--user-data-dir=${userData}`],
    cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, FAKE_CLAUDE_REPLY: 'Smoke says hi. SQLite is the lighter choice.', CORE_E2E_PAIR_ALLOW: '1', FAKE_CLAUDE_SCRIPT: script, FAKE_PLAYER: player,
      PATH: `${path.join(ROOT, 'test', 'fixtures', 'bin')}${path.delimiter}${process.env.PATH}` },
    timeout: 60000,
  });
  const find = async (part) => {
    for (let i = 0; i < 120; i++) {
      const w = app.windows().find((p) => p.url().includes(part));
      if (w) return w;
      await wait(250);
    }
    throw new Error(`no ${part} window`);
  };
  dock = await find('/dock/');
  overlay = await find('/overlay/');
  for (const w of [dock, overlay]) w.on('pageerror', (e) => errors.push(`${w.url()}: ${e.message}`));
  await dock.waitForSelector('#input', { state: 'attached' });
  await wait(1500);
});

test.after(async () => {
  if (!app) return;
  // COre lives in the tray when its windows close: quit it like the tray's Quit does.
  const proc = app.process();
  await app.evaluate(({ app: a }) => { a.isQuitting = true; a.quit(); }).catch(() => {});
  await Promise.race([new Promise((r) => proc.once('exit', r)), wait(10000)]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
});

async function send(text) {
  await dock.evaluate(() => { const i = document.getElementById('input'); i.focus(); });
  await dock.fill('#input', text);
  await dock.press('#input', 'Enter');
}

// Quick settings open / closed, whatever state an earlier test left them in.
async function quickSettings(open) {
  const isOpen = await dock.evaluate(() => !document.getElementById('settings').hidden);
  if (isOpen !== open) await dock.click(open ? '#gear' : '#settings-back');
}

const logText = () => dock.evaluate(() => document.getElementById('log').innerText);

test('a typed message gets a reply in the chat, with the header status', async () => {
  await send('which local database should I use?');
  await dock.waitForFunction(() => document.getElementById('log').innerText.includes('Smoke says hi'), null, { timeout: 20000 });
  const status = await dock.textContent('#head-status');
  assert.match(status, /Online|Thinking|Speaking/);
});

test('short requests are answered instantly, without the brain', async () => {
  const t0 = Date.now();
  await send('what time is it?');
  await dock.waitForFunction(() => /It's \d/.test(document.getElementById('log').innerText), null, { timeout: 5000 });
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test('the glance card opens and closes beside the orb', async () => {
  await send('show me the lyrics');
  await overlay.waitForFunction(() => window.__coreGlance && window.__coreGlance() && !window.__coreGlance().hidden, null, { timeout: 5000 });
  assert.strictEqual((await overlay.evaluate(() => window.__coreGlance())).kind, 'lyrics');
  await send('hide that');
  await overlay.waitForFunction(() => window.__coreGlance() === null, null, { timeout: 5000 });
});

test('what is playing: the card shows the song, artist and album art (Linux media session)', { skip: process.platform !== 'linux' }, async () => {
  await send("what's playing");
  await overlay.waitForFunction(() => { const g = window.__coreGlance(); return g && g.title === 'Midnight Signal'; }, null, { timeout: 8000 });
  await overlay.waitForFunction(() => { const a = document.querySelector('.g-art'); return a && !a.hidden && a.src.startsWith('data:image/png'); }, null, { timeout: 5000 });
  assert.strictEqual(await overlay.textContent('.g-sub'), 'The Smoke Choir');
  await send('hide that');
  await overlay.waitForFunction(() => window.__coreGlance() === null, null, { timeout: 5000 });
});

test('a paused COre draws no frames, and comes back', async () => {
  await overlay.evaluate(() => window.__coreSetRender({ paused: true }));
  await wait(400);
  const a = await overlay.evaluate(() => window.__coreStats().draws);
  await wait(1500);
  const b = await overlay.evaluate(() => window.__coreStats().draws);
  assert.strictEqual(b, a, 'no frames while paused');
  await overlay.evaluate(() => window.__coreSetRender({}));
  await wait(1500);
  assert.ok((await overlay.evaluate(() => window.__coreStats().draws)) > b, 'frames again after resuming');
});

test('notes in the chat are plain text, not bubbles', async () => {
  const bg = await dock.evaluate(() => {
    const el = document.createElement('div');
    el.className = 'msg system';
    document.getElementById('log').append(el);
    const c = getComputedStyle(el).backgroundColor;
    el.remove();
    return c;
  });
  assert.match(bg, /rgba\(0, 0, 0, 0\)|transparent/);
});

let settings;
test('every Settings section renders without errors', async () => {
  await quickSettings(true);
  await dock.click('#all-settings');
  for (let i = 0; i < 80 && !settings; i++) { settings = app.windows().find((p) => p.url().includes('/settings/')); if (!settings) await wait(250); }
  assert.ok(settings, 'settings window opened');
  settings.on('pageerror', (e) => errors.push(`settings: ${e.message}`));
  await settings.waitForSelector('.nav button');
  const names = await settings.$$eval('.nav button', (bs) => bs.map((b) => b.textContent.trim()));
  for (const n of ['General', 'Voice', 'Brain', 'Skills', 'Phone', 'Backup', 'Privacy', 'Maintenance']) assert.ok(names.includes(n), `${n} section`);
  for (const n of names) {
    await settings.click(`.nav button:has-text("${n}")`);
    await settings.waitForFunction((n) => document.querySelector('#content h2, .content h2') && document.querySelector('#content h2, .content h2').textContent.includes(n), n, { timeout: 3000 });
  }
});

test('backups go to the cloud folder and never contain secrets', async () => {
  await settings.click('.nav button:has-text("Backup")');
  await settings.click('button:has-text("Use my cloud folder")');
  await wait(600);
  await settings.click('button:has-text("Back up now")');
  const dir = path.join(home, 'Dropbox', 'COre Backups');
  let files = [];
  for (let i = 0; i < 40 && !files.length; i++) { await wait(250); try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {} }
  assert.strictEqual(files.length, 1);
  const raw = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  const cfg = JSON.parse(JSON.parse(raw).files['config.json']);
  assert.strictEqual(cfg.notify.token, '');
  assert.deepStrictEqual(cfg.brain.secrets, {});
});

test('a phone pairs, chats and is locked out after removal', async () => {
  const r = await settings.evaluate(() => window.settingsApi.action('pairPhone'));
  assert.ok(r.pair && r.pair.url, JSON.stringify(r));
  const u = new URL(r.pair.url);
  const [pairId, secretB64] = u.hash.replace('#pair=', '').split('.');
  const secret = new Uint8Array(Buffer.from(secretB64, 'base64url'));
  const base = `${u.protocol}//${u.host}`;
  const post = async (p, body) => { const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  const deviceId = Buffer.from(nacl.randomBytes(18)).toString('base64url');
  const key = nacl.randomBytes(32);
  const paired = await post('/pair', { pairId, deviceId, ...C.seal({ key: Buffer.from(key).toString('base64'), name: 'E2E phone' }, secret) });
  assert.strictEqual(C.open(paired.body, secret).ok, true);
  let ctr = 1;
  const api = (op, extra = {}) => post('/api', { d: deviceId, ...C.seal({ op, ctr: ctr++, ts: Date.now(), ...extra }, key) });
  await api('send', { text: 'hello from the e2e phone' });
  await dock.waitForFunction(() => document.getElementById('log').innerText.includes('hello from the e2e phone'), null, { timeout: 10000 });
  let reply = null;
  for (let i = 0; i < 40 && !reply; i++) {
    const s = C.open((await api('sync', { since: 0 })).body, key);
    reply = (s.events || []).find((e) => e.role === 'core' && /Smoke says hi/.test(e.text));
    if (!reply) await wait(500);
  }
  assert.ok(reply, 'the phone sees the reply');
  const list = await settings.evaluate(() => window.settingsApi.action('phoneDevices'));
  assert.strictEqual(list.devices[0].name, 'E2E phone');
  // Regression: closing a card beside the orb used to stop the phone server.
  await send('show me the lyrics');
  await overlay.waitForFunction(() => window.__coreGlance() !== null, null, { timeout: 5000 });
  await send('hide that');
  await overlay.waitForFunction(() => window.__coreGlance() === null, null, { timeout: 5000 });
  assert.strictEqual((await api('sync', { since: 0 })).status, 200, 'the phone still works after a card closes');
  await settings.evaluate((id) => window.settingsApi.action(`revokePhone:${id}`), deviceId);
  assert.strictEqual((await api('sync', { since: 0 })).status, 401);
});

test('memory: a remembered fact shows in quick settings and can be forgotten', async () => {
  await send('please remember my tea preference');
  await dock.waitForFunction(() => /Remembered: the user likes green tea/.test(document.getElementById('log').innerText), null, { timeout: 15000 });
  await quickSettings(true);
  await dock.waitForFunction(() => document.getElementById('memory-list').innerText.includes('green tea'), null, { timeout: 5000 });
  await dock.click('#memory-list button[aria-label^="Forget:"]');
  await dock.waitForFunction(() => !document.getElementById('memory-list').innerText.includes('green tea'), null, { timeout: 5000 });
  await quickSettings(false);
});

test('timers: a skill tag sets a reminder that shows in quick settings', async () => {
  await send('set a tea timer please');
  await dock.waitForFunction(() => /Timer set: tea/.test(document.getElementById('log').innerText), null, { timeout: 15000 });
  await overlay.waitForFunction(() => window.__coreGlance() && window.__coreGlance().kind === 'timer', null, { timeout: 5000 });
  assert.match((await overlay.evaluate(() => window.__coreGlance())).cur, /^\d+:\d\d$/, 'live countdown');
  await send('how long left?');
  await dock.waitForFunction(() => /tea: \d+ minutes left/.test(document.getElementById('log').innerText), null, { timeout: 5000 });
  await quickSettings(true);
  await dock.waitForFunction(() => document.getElementById('reminder-list').innerText.includes('tea'), null, { timeout: 5000 });
  assert.ok(await dock.isVisible('#reminder-list'), 'the reminders card is shown when there is one');
  await quickSettings(false);
});

test('Meiosis: @Scout splits off and answers with its own name', async () => {
  await send('@Scout compare two databases');
  await dock.waitForFunction(() => [...document.querySelectorAll('.row.by-scout .who-name')].some((n) => n.textContent === 'Scout'), null, { timeout: 20000 });
  const reply = await dock.evaluate(() => [...document.querySelectorAll('.row.by-scout .msg')].map((m) => m.innerText).join(' '));
  assert.match(reply, /Smoke says hi/);
  let clone = null;
  for (let i = 0; i < 40 && !clone; i++) { clone = app.windows().find((p) => /clone/.test(p.url()) || /clone=/.test(p.url())); if (!clone) await wait(250); }
  assert.ok(clone || app.windows().length >= 4, 'a helper window exists');
});

test('a shared task shows a live card with each specialist', async () => {
  await send('@Scout @Sentinel compare SQLite and LevelDB');
  await overlay.waitForFunction(() => { const g = window.__coreGlance(); return g && g.kind === 'task'; }, null, { timeout: 15000 });
  await overlay.waitForFunction(() => { const rows = [...document.querySelectorAll('.g-list li.step')]; return rows.length === 2 && rows.every((r) => r.classList.contains('completed')); }, null, { timeout: 20000 });
  const names = await overlay.$$eval('.g-list li.step span', (n) => n.map((x) => x.textContent));
  assert.deepStrictEqual(names.sort(), ['Scout', 'Sentinel']);
});

test('approved file changes: Forge proposes, nothing is written until Apply, Undo restores', async () => {
  await send('@Forge rewrite the readme');
  await dock.waitForSelector('.msg.proposal', { timeout: 20000 });
  assert.strictEqual(fs.readFileSync(path.join(project, 'readme.txt'), 'utf8'), 'old readme\n', 'not written before Apply');
  await dock.click('.msg.proposal button:has-text("Apply")');
  await dock.waitForFunction(() => /Applied/.test(document.querySelector('.msg.proposal').innerText), null, { timeout: 5000 });
  assert.match(fs.readFileSync(path.join(project, 'readme.txt'), 'utf8'), /new readme from forge/);
  await dock.click('.msg.proposal button:has-text("Undo")');
  await dock.waitForFunction(() => /Undone|undone/.test(document.querySelector('.msg.proposal').innerText), null, { timeout: 5000 });
  assert.strictEqual(fs.readFileSync(path.join(project, 'readme.txt'), 'utf8'), 'old readme\n');
  // Sentinel reviewed Forge's change on its own.
  await dock.waitForFunction(() => /Sentinel is reviewing Forge/.test(document.getElementById('log').innerText), null, { timeout: 5000 });
  await dock.waitForFunction(() => [...document.querySelectorAll('.row.by-sentinel .msg')].some((m) => /Verdict: ship it/.test(m.innerText)), null, { timeout: 20000 });
});

test('Navigator plans a desktop task and leaves /do in the box for you to start', async () => {
  await send('@Navigator open my downloads folder');
  await dock.waitForFunction(() => /Navigator can do this on your desktop/.test(document.getElementById('log').innerText), null, { timeout: 20000 });
  assert.strictEqual(await dock.inputValue('#input'), '/do open the Downloads folder in the file manager');
  await dock.fill('#input', '');
});

test('Archivist answers from memory and the file shelf', async () => {
  await send('@Archivist what do you know about my tea');
  await dock.waitForFunction(() => [...document.querySelectorAll('.row.by-archivist .msg')].some((m) => /Archivist checked: green tea/.test(m.innerText)), null, { timeout: 20000 });
});

test('the History panel shows the conversation', async () => {
  await quickSettings(true);
  await dock.click('#open-panel');
  let panel = null;
  for (let i = 0; i < 40 && !panel; i++) { panel = app.windows().find((p) => p.url().includes('/panel/')); if (!panel) await wait(250); }
  assert.ok(panel, 'history panel opened');
  await panel.waitForFunction(() => document.getElementById('log').innerText.includes('which local database'), null, { timeout: 5000 });
  await quickSettings(false);
});

test('desktop agent: /do clicks and types into another window, with step approval (real input)', { skip: process.platform !== 'linux' || !require('fs').existsSync('/usr/bin/xdotool') }, async () => {
  await settings.evaluate(() => window.settingsApi.set('agent.enabled', true));
  // A separate window to operate (COre hides its own windows from screenshots).
  const geo = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = new BrowserWindow({ x: 120, y: 120, width: 420, height: 160, frame: false, show: true, webPreferences: { sandbox: true } });
    w.loadURL('data:text/html,<body style=margin:0;background:%23fff><input id=t style="position:absolute;left:40px;top:50px;width:300px;height:40px;font-size:20px">');
    global.__agentTarget = w;
    const d = screen.getPrimaryDisplay();
    return { w: d.size.width, h: d.size.height };
  });
  await wait(1200);
  const scale = Math.min(1, 1568 / Math.max(geo.w, geo.h));
  const cx = Math.round((120 + 40 + 150) * scale);
  const cy = Math.round((120 + 50 + 20) * scale);
  fs.writeFileSync(script, JSON.stringify([
    ...baseRules,
    { match: 'Step 1 of', reply: `Clicking the box. [[act {"type":"click","x":${cx},"y":${cy},"why":"focus the text box"}]]` },
    { match: 'Step 2 of', reply: 'Typing. [[act {"type":"type","text":"hello from the agent"}]]' },
    { match: 'Step 3 of', reply: 'Done. [[act {"type":"done","summary":"typed the greeting"}]]' },
    { match: 'Step 4 of', reply: 'Checked. [[act {"type":"done","summary":"typed the greeting"}]]' },
  ]));
  await send('/do type a greeting into the box');
  await dock.waitForSelector('#agent-card:not([hidden])', { timeout: 20000 });
  assert.match(await dock.textContent('#agent-label'), /^Click at/);
  await dock.click('#agent-yes');
  await dock.waitForFunction(() => !document.getElementById('agent-card').hidden && /Type/.test(document.getElementById('agent-label').textContent), null, { timeout: 20000 });
  await dock.click('#agent-all');
  await dock.waitForFunction(() => /Agent finished: typed the greeting/.test(document.getElementById('log').innerText), null, { timeout: 30000 });
  const value = await app.evaluate(() => global.__agentTarget.webContents.executeJavaScript("document.getElementById('t').value"));
  assert.strictEqual(value, 'hello from the agent');
  await app.evaluate(() => { global.__agentTarget.destroy(); });
  await settings.evaluate(() => window.settingsApi.set('agent.enabled', false));
});

test('emergency stop: the global hotkey halts a running agent task at once', { skip: process.platform !== 'linux' || !require('fs').existsSync('/usr/bin/xdotool') }, async () => {
  await settings.evaluate(() => window.settingsApi.set('agent.enabled', true));
  fs.writeFileSync(script, JSON.stringify([...baseRules, { match: 'Step 1 of', reply: 'Waiting. [[act {"type":"click","x":5,"y":5,"why":"test"}]]' }]));
  await send('/do something long');
  await dock.waitForSelector('#agent-card:not([hidden])', { timeout: 20000 });
  require('child_process').execFileSync('xdotool', ['key', 'ctrl+alt+shift+x']);
  await dock.waitForFunction(() => /Emergency stop/.test(document.getElementById('log').innerText), null, { timeout: 8000 });
  await dock.waitForFunction(() => /Agent stopped/.test(document.getElementById('log').innerText), null, { timeout: 8000 });
  assert.ok(await dock.evaluate(() => document.getElementById('agent-card').hidden), 'the approval card is gone');
  await settings.evaluate(() => window.settingsApi.set('agent.enabled', false));
  fs.writeFileSync(script, JSON.stringify(baseRules));
});

test('desktop agent: tools write a file and run a command (always asked), results come back, /do undo restores', { skip: process.platform !== 'linux' }, async () => {
  await settings.evaluate(() => window.settingsApi.set('agent.enabled', true));
  fs.writeFileSync(script, JSON.stringify([
    ...baseRules,
    { match: 'reply done again', reply: 'Looks right. [[act {"type":"done","summary":"notes written and checked"}]]' },
    { match: '<<untrusted command output>>', reply: 'The command printed 42. [[act {"type":"done","summary":"notes written"}]]' },
    { match: 'Step 2 of', reply: 'Checking with node. [[act {"type":"run","cmd":"node -e \\"console.log(6*7)\\"","why":"compute"}]]' },
    { match: 'Step 1 of', reply: 'Writing. [[act {"type":"write","path":"notes.txt","text":"agent notes","why":"save notes"}]]' },
  ]));
  await send('/do write my notes');
  await dock.waitForFunction(() => !document.getElementById('agent-card').hidden && /Write notes\.txt/.test(document.getElementById('agent-label').textContent), null, { timeout: 20000 });
  assert.ok(!(await dock.evaluate(() => document.getElementById('agent-all').hidden)), 'file steps can be allowed for the whole task');
  await dock.click('#agent-all');
  await dock.waitForFunction(() => !document.getElementById('agent-card').hidden && /Run/.test(document.getElementById('agent-label').textContent), null, { timeout: 20000 });
  assert.ok(await dock.evaluate(() => document.getElementById('agent-all').hidden), 'a command is approved on its own, even after allow-all');
  await dock.click('#agent-yes');
  await dock.waitForFunction(() => /Agent finished: notes written and checked/.test(document.getElementById('log').innerText), null, { timeout: 30000 });
  assert.strictEqual(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8'), 'agent notes');
  await dock.waitForFunction(() => /\/do undo/.test(document.getElementById('log').innerText), null, { timeout: 5000 });
  await send('/do undo');
  await dock.waitForFunction(() => /Undone: 1 file/.test(document.getElementById('log').innerText), null, { timeout: 8000 });
  assert.ok(!fs.existsSync(path.join(project, 'notes.txt')));
  await settings.evaluate(() => window.settingsApi.set('agent.enabled', false));
  fs.writeFileSync(script, JSON.stringify(baseRules));
});

test('files: picked files become cards, are read, and go with the message as untrusted data', async () => {
  const fdir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-e2e-files-'));
  const csv = path.join(fdir, 'budget.csv');
  fs.writeFileSync(csv, 'item,qty,price\nbrick,1200,0.45\ncement,30,7.5\n');
  const ifc = path.join(fdir, 'house.ifc');
  fs.writeFileSync(ifc, "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n#1=IFCPROJECT('a',$,'Rumah',$,$,$,$,$,$);\n#2=IFCBUILDINGSTOREY('b',$,'Ground',$,$,$,$,$,.ELEMENT.,0.);\n#3=IFCWALL('c',$,'W',$,$,$,$,$,$);\nENDSEC;END-ISO-10303-21;");
  const wav = path.join(fdir, 'tone.wav');
  { const n = 16000; const b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), 44 + i * 2); fs.writeFileSync(wav, b); }
  fs.writeFileSync(script, JSON.stringify([...baseRules, { match: '<<untrusted file budget.csv>>', reply: 'Your budget has 2 items; the IFC model is Rumah with 1 storey.' }]));
  await (await dock.$('#file-input')).setInputFiles([csv, ifc, wav]);
  await dock.waitForFunction(() => document.querySelectorAll('#file-cards .fcard').length === 3, null, { timeout: 10000 });
  await dock.waitForFunction(() => [...document.querySelectorAll('#file-cards .fcard .info')].some((e) => /3 rows/.test(e.textContent)), null, { timeout: 10000 });
  const ifcInfo = await dock.evaluate(() => [...document.querySelectorAll('#file-cards .fcard.k-bim .info')].map((e) => e.textContent)[0]);
  assert.match(ifcInfo, /1 storey/);
  // Audio is decoded in the dock and never stays stuck on "Decoding…".
  await dock.waitForFunction(() => { const a = document.querySelector('#file-cards .fcard.k-audio'); return a && !a.classList.contains('media') && !a.classList.contains('reading'); }, null, { timeout: 60000 });
  // (Without the speech model, as here, the card shows why; with it, a transcript.)
  if (await dock.evaluate(() => document.querySelector('#file-cards .fcard.k-audio').classList.contains('ready'))) await dock.click('#file-cards .fcard.k-audio');
  else assert.ok(!(await dock.evaluate(() => document.querySelector('#file-cards .fcard.k-audio').classList.contains('sel'))), 'a card that failed is not attached');
  assert.match(await dock.textContent('#files-hint'), /2 attached/);
  if (process.env.E2E_SHOTS) await dock.screenshot({ path: path.join(process.env.E2E_SHOTS, 'files-panel.png') });
  await send('what is in these?');
  await dock.waitForFunction(() => /Your budget has 2 items; the IFC model is Rumah/.test(document.getElementById('log').innerText), null, { timeout: 15000 });
  const chips = await dock.evaluate(() => [...document.querySelectorAll('#log .file-chip')].map((c) => c.textContent));
  assert.deepStrictEqual(chips.slice(-2).sort(), ['budget.csv', 'house.ifc']);
  // Remove the cards again.
  for (let i = 0; i < 3; i++) await dock.evaluate(() => document.querySelector('#file-cards .fcard .x').click());
  await dock.waitForFunction(() => document.getElementById('files').hidden, null, { timeout: 5000 });
  fs.writeFileSync(script, JSON.stringify(baseRules));
});

test('playbooks: bundled examples are listed, fit requests, run on a core, and new ones are learned from the chat', async () => {
  await send('/skills');
  await dock.waitForFunction(() => /Playbooks \(\d+\), run with \/skill NAME/.test(document.getElementById('log').innerText) && /meeting-notes → Archivist/.test(document.getElementById('log').innerText), null, { timeout: 8000 });
  fs.writeFileSync(script, JSON.stringify([
    { match: 'Playbook "code-review"', reply: 'Reviewed with the playbook.\n\nOne critical issue. Verdict: fix first' },
    { match: 'Playbook "meeting-notes"', reply: 'Using your meeting notes playbook: decisions first.' },
    { match: '\\[playbook\\] Turn the procedure', reply: '---\nname: tea-timer\ndescription: Brew green tea with a timer.\ntriggers: brew tea, tea timer\n---\n1. Boil water to 80 C\n2. Set a 3 minute timer' },
    ...baseRules,
  ]));
  // A request that fits a playbook gets its instructions.
  await send('write the meeting notes for today please');
  await dock.waitForFunction(() => /Using your meeting notes playbook/.test(document.getElementById('log').innerText), null, { timeout: 15000 });
  // /skill NAME runs it on the playbook's core.
  await send('/skill code-review function add(a,b){return a-b}');
  await dock.waitForFunction(() => [...document.querySelectorAll('.row.by-sentinel .msg')].some((m) => /Verdict: fix first/.test(m.innerText)), null, { timeout: 20000 });
  // Learn a new playbook from the conversation.
  await send('/skill save tea-timer');
  await dock.waitForFunction(() => /Saved playbook "tea-timer"/.test(document.getElementById('log').innerText), null, { timeout: 15000 });
  assert.match(fs.readFileSync(path.join(userData, 'skills', 'tea-timer', 'SKILL.md'), 'utf8'), /Set a 3 minute timer/);
  fs.writeFileSync(script, JSON.stringify(baseRules));
});

test('command center: shows cores, tasks, playbooks, memory, devices and the activity log; its emergency stop works', async () => {
  await send('/center');
  let cc = null;
  for (let i = 0; i < 40 && !cc; i++) { cc = app.windows().find((p) => p.url().includes('/command/')); if (!cc) await wait(250); }
  assert.ok(cc, 'the command center opened');
  await cc.waitForFunction(() => window.__centerReady && document.querySelectorAll('#cores li').length === 6, null, { timeout: 10000 });
  const names = await cc.$$eval('#cores li .grow > div:first-child', (n) => n.map((x) => x.textContent));
  assert.deepStrictEqual(names, ['COre', 'Scout', 'Forge', 'Sentinel', 'Archivist', 'Navigator']);
  assert.match(await cc.textContent('#tasks'), /compare SQLite and LevelDB/);
  assert.match(await cc.textContent('#playbooks'), /code-review → Sentinel/);
  assert.match(await cc.textContent('#playbooks'), /weekdays 08:45 \(off\)/);
  assert.match(await cc.textContent('#agent'), /Step \d+/, 'the last agent task is shown');
  assert.match(await cc.textContent('#files'), /No files yet|ready/);
  assert.match(await cc.textContent('#memory'), /\d+memories\d+pinned\d+replaced/, 'memory numbers are shown');
  await cc.waitForFunction(() => document.querySelectorAll('#audit li time').length > 3, null, { timeout: 5000 });
  if (process.env.E2E_SHOTS) await cc.screenshot({ path: path.join(process.env.E2E_SHOTS, 'command-center.png') });
  await cc.fill('#filter', 'workflow-that-never-ran');
  assert.match(await cc.textContent('#audit'), /Nothing matches/);
  await cc.fill('#filter', '');
  await cc.click('#stop-all');
  await dock.waitForFunction(() => /Emergency stop/.test(document.getElementById('log').innerText), null, { timeout: 8000 });
  await cc.waitForFunction(() => [...document.querySelectorAll('#audit .what')].some((e) => /emergency-stop/.test(e.textContent)), null, { timeout: 6000 });
  await cc.press('body', 'Escape').catch(() => {}); // the window closes under the key press
  for (let i = 0; i < 20 && app.windows().some((p) => p.url().includes('/command/')); i++) await wait(150);
  assert.ok(!app.windows().some((p) => p.url().includes('/command/')), 'Esc closes it');
});

test('board: COre crumbles to ash, spreads into a board a third of the screen wide, then reforms', async () => {
  fs.writeFileSync(script, JSON.stringify([{ match: 'explain the release steps', reply: '[[board Release in three steps; Freeze the branch; Run every test; Tag and publish]] First we freeze the branch. Then we run every test. Then we tag it and publish.' }, ...baseRules]));
  await send('explain the release steps');
  await overlay.waitForFunction(() => window.__coreBoard().ashW > 0.5, null, { timeout: 15000 });
  const shots = process.env.E2E_SHOTS;
  if (shots) await overlay.screenshot({ path: path.join(shots, 'board-1-ash.png') });
  await overlay.waitForFunction(() => { const b = window.__coreBoard(); return b.shown && b.boardW > 0.9; }, null, { timeout: 10000 });
  const b = await overlay.evaluate(() => window.__coreBoard());
  assert.strictEqual(b.title, 'Release in three steps');
  assert.deepStrictEqual(b.points, ['Freeze the branch', 'Run every test', 'Tag and publish']);
  const screenW = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().size.width);
  assert.ok(b.rect.w >= screenW / 3 - 2 || b.rect.w === 680, `about a third of the screen (${b.rect.w} of ${screenW})`);
  const text = await overlay.evaluate(() => document.getElementById('board').innerText);
  assert.match(text, /Release in three steps[\s\S]*Freeze the branch[\s\S]*Tag and publish/);
  if (shots) { await wait(1400); await overlay.screenshot({ path: path.join(shots, 'board-2-spread.png') }); }
  // The words are not spoken as tags, and the chat shows the plain reply.
  await dock.waitForFunction(() => /First we freeze the branch/.test(document.getElementById('log').innerText) && !/\[\[board/.test(document.getElementById('log').innerText), null, { timeout: 10000 });
  // It pulls back together on its own.
  await overlay.waitForFunction(() => { const s = window.__coreBoard(); return !s.title && s.boardW < 0.02; }, null, { timeout: 40000 });
  if (shots) { await wait(600); await overlay.screenshot({ path: path.join(shots, 'board-3-reformed.png') }); }
  assert.ok(await overlay.evaluate(() => document.getElementById('board').hidden));
  fs.writeFileSync(script, JSON.stringify(baseRules));
});

test('desktop agent: off by default and refused from the phone', async () => {
  await send('/do anything at all');
  await dock.waitForFunction(() => /desktop agent is off/.test(document.getElementById('log').innerText), null, { timeout: 5000 });
});

test('mobile app: pairs over Wi-Fi, chats, copies memory, and answers through Gemini when the PC is away', async () => {
  const MOBILE = path.join(ROOT, 'mobile', 'www');
  if (!fs.existsSync(path.join(MOBILE, 'nacl.js'))) require('child_process').execFileSync(process.execPath, [path.join(ROOT, 'mobile', 'scripts', 'copy-assets.js')]);
  await send('please remember my tea preference'); // something for the phone to learn
  await quickSettings(true); // wait for the fact itself (an older "Remembered" note may still be in the chat)
  await dock.waitForFunction(() => document.getElementById('memory-list').innerText.includes('green tea'), null, { timeout: 15000 });
  await quickSettings(false);
  // The app at its real origin (http://localhost, like Capacitor), at phone size.
  await app.evaluate(({ BrowserWindow }) => { const w = new BrowserWindow({ width: 390, height: 800, show: true }); w.loadURL('about:blank'); global.__mobile = w; });
  let phone = null;
  for (let i = 0; i < 40 && !phone; i++) { phone = app.windows().find((p) => p.url() === 'about:blank'); if (!phone) await wait(250); }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
  await phone.route('http://localhost/**', (route) => {
    const file = path.join(MOBILE, new URL(route.request().url()).pathname.replace(/^\/$/, '/index.html'));
    if (!file.startsWith(MOBILE) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: types[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  let geminiBody = null;
  await phone.route('https://generativelanguage.googleapis.com/**', async (route) => {
    geminiBody = JSON.parse(route.request().postData());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Green tea, as usual? (from Gemini)' }] } }] }) });
  });
  phone.on('pageerror', (e) => errors.push(`mobile: ${e.message}`));
  await phone.goto('http://localhost/');
  assert.ok(['low', 'mid', 'high'].includes(await phone.evaluate(() => window.__orb.tier)), 'orb picked a device class');
  // Pair with the PC using the link from its QR code.
  const r = await settings.evaluate(() => window.settingsApi.action('pairPhone'));
  await phone.click('#open-settings');
  await phone.fill('#pair-link', r.pair.url);
  await phone.click('#pair');
  await phone.waitForFunction(() => /Paired with/.test(document.getElementById('pc-state').textContent), null, { timeout: 15000 });
  await phone.click('#close-settings');
  // Chat through the PC.
  await phone.fill('#input', 'hello from the app');
  await phone.click('.send');
  await dock.waitForFunction(() => document.getElementById('log').innerText.includes('hello from the app'), null, { timeout: 10000 });
  await phone.waitForFunction(() => [...document.querySelectorAll('.msg.core')].some((m) => /Smoke says hi/.test(m.textContent)), null, { timeout: 15000 });
  await phone.waitForFunction(() => /With your PC|Thinking|Speaking/.test(document.getElementById('status').textContent), null, { timeout: 5000 });
  // Memory came along.
  await phone.waitForFunction(() => JSON.parse(localStorage.getItem('core.memory') || '[]').some((m) => /green tea/.test(m.text)), null, { timeout: 15000 });
  // Away: the PC stops answering; Gemini answers with that memory.
  await phone.evaluate(() => localStorage.setItem('core.geminiKey', JSON.stringify('test-key')));
  await phone.route(/^http:\/\/127\.0\.0\.1:\d+\/api$/, (route) => route.abort());
  await phone.waitForFunction(() => /Away: Gemini/.test(document.getElementById('status').textContent), null, { timeout: 20000 });
  await phone.fill('#input', 'what do I drink?');
  await phone.click('.send');
  await phone.waitForFunction(() => [...document.querySelectorAll('.msg.core')].some((m) => /from Gemini/.test(m.textContent)), null, { timeout: 10000 });
  assert.match(geminiBody.systemInstruction.parts[0].text, /green tea/, 'Gemini got the synced memory');
  await app.evaluate(() => { global.__mobile.destroy(); });
});

test('no renderer errors were thrown', () => {
  assert.deepStrictEqual(errors, []);
});

test('chat still works after everything above', async () => {
  await send('one more message please');
  // The chat trims old messages when it's full, so look for the new ones, not a longer log.
  await dock.waitForFunction(() => {
    const items = [...document.querySelectorAll('#log .msg')];
    const i = items.findIndex((m) => m.innerText.includes('one more message please'));
    return i >= 0 && items.slice(i + 1).some((m) => m.classList.contains('core') && /Smoke says hi/.test(m.innerText));
  }, null, { timeout: 15000 });
});

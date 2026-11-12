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

// A local stand-in for a second AI provider (OpenAI-compatible, streaming) and
// for Jev's decision endpoint, so routing and failover run in the real app.
const fake = { chats: [], decisions: [], jevAnswers: null, port: 0, server: null };
// The real Cortex knowledge vault (MCP), when a checkout is available (CI clones it).
const CORTEX_DIR = [process.env.CORTEX_DIR, path.join(__dirname, '..', '..', 'rawsushies', 'cortex-ai-brain')].find((d) => d && fs.existsSync(path.join(d, 'run.py')));
const cortexVault = fs.mkdtempSync(path.join(os.tmpdir(), 'core-e2e-vault-'));
function startFakeProviders() {
  const http = require('http');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'backup-model' }] })); return; }
      if (req.url === '/v1/chat/completions') {
        const j = JSON.parse(body);
        fake.chats.push(j);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const piece of ['From the ', 'backup brain.']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      if (req.url === '/v1/systemone') {
        fake.decisions.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        res.end(JSON.stringify({ model: 'jev-test', answers: fake.jevAnswers || {} }));
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  fake.server = server;
  return new Promise((r) => server.listen(0, '127.0.0.1', () => { fake.port = server.address().port; r(server); }));
}

test.before(async () => {
  await startFakeProviders();
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
    // Cores see each other's work in their prompts: most specific rules first.
    { match: 'open my downloads folder', reply: 'I would open the file manager.\n\n1. Open Files\n2. Click Downloads\nTask: open the Downloads folder in the file manager' },
    { match: 'Memory stats\\] \\d+ memories', reply: 'From memory.\n\nArchivist checked: green tea, noted earlier.' },
    { match: 'Review the file changes', reply: 'Looks fine.\n\nThe readme change is plain text. Verdict: ship it' },
    { match: 'rewrite the readme', reply: '{core} here, proposing it.\n\n```txt file=readme.txt\nnew readme from forge\n```' },
    { match: 'remember my tea', reply: 'Got it. [[remember the user likes green tea]]' },
    { match: 'set a tea timer', reply: 'Timer on. [[do timer 10m tea]]' },
  ]));
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    orb: { graphics: 'software' },
    brain: {
      claude: { command: path.join(ROOT, 'test', 'fixtures', 'fake-claude.js') },
      fallbacks: ['openai-compat'],
      openaiCompat: { baseUrl: `http://127.0.0.1:${fake.port}/v1`, model: 'backup-model', noKey: true },
      jev: { enabled: true, provider: 'typesafe', endpoint: `http://127.0.0.1:${fake.port}`, timeoutMs: 2000 },
      secrets: { jev: 'plain:test-jev-key' },
    },
    ...(CORTEX_DIR ? { memory: { cortex: { enabled: true, command: process.platform === 'win32' ? 'python' : 'python3', script: path.join(CORTEX_DIR, 'run.py'), vault: cortexVault } } } : {}),
    voice: { tts: false },
    presence: { chitchat: false },
    update: { enabled: false },
    phone: { host: '127.0.0.1', port: 0 },
    tools: { projectRoot: project, enabled: true, allowWrites: true },
    skills: { lyrics: false }, // no network in tests
    events: { files: true, rules: [{ name: 'CSV intake', source: 'files', match: 'intake-*.csv', on: 'created', playbook: 'csv-intake', mode: 'auto', cooldownMin: 0 }] },
  }));
  fs.writeFileSync(path.join(userData, 'state.json'), JSON.stringify({ onboarded: true }));
  app = await electron.launch({
    args: ['--no-sandbox', ROOT, `--user-data-dir=${userData}`],
    cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, FAKE_CLAUDE_REPLY: 'Smoke says hi. SQLite is the lighter choice.', CORE_E2E_PAIR_ALLOW: '1', FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_ARGS: path.join(userData, 'fake-args.log'), FAKE_CLAUDE_PROMPTS: process.env.E2E_PROMPTS || '', FAKE_PLAYER: player,
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
  if (fake.server) { fake.server.closeAllConnections(); fake.server.close(); }
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

test('cores read each other: Prime knows what Scout found; helpers spawn clear of the chat and can be dragged', async () => {
  fs.writeFileSync(script, JSON.stringify([
    { match: "Specialists' work[\\s\\S]*Scout found: the blue tent", full: true, reply: 'Scout already checked: the blue tent wins.' },
    { match: 'pick a tent for me', reply: 'Comparing.\n\nScout found: the blue tent is lighter and cheaper.' },
    ...baseRules,
  ]));
  await send('@Scout pick a tent for me');
  await dock.waitForFunction(() => /Scout found: the blue tent/.test(document.getElementById('log').innerText), null, { timeout: 20000 });
  await send('what did scout decide?');
  await dock.waitForFunction(() => /Scout already checked: the blue tent wins/.test(document.getElementById('log').innerText), null, { timeout: 15000 });
  // Placement: the helper's window never overlaps the chat (after its split animation).
  await wait(1800);
  const rects = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).map((w) => ({ url: w.webContents.getURL(), b: w.getBounds() })));
  const chat = rects.find((r) => r.url.includes('/dock/')).b;
  const helper = rects.find((r) => /clone/.test(r.url));
  assert.ok(helper, 'Scout is on screen');
  const h = helper.b;
  assert.ok(h.x >= chat.x + chat.width || h.x + h.width <= chat.x || h.y >= chat.y + chat.height || h.y + h.height <= chat.y, `helper ${JSON.stringify(h)} clear of chat ${JSON.stringify(chat)}`);
  // Drag it with the real mouse by its orb.
  if (process.platform === 'linux' && fs.existsSync('/usr/bin/xdotool')) {
    const x = require('child_process');
    const cx = h.x + h.width / 2; const cy = h.y + h.height / 2;
    x.execFileSync('xdotool', ['mousemove', String(cx), String(cy)]);
    await wait(500); // helpers are click-through until the pointer rests over their smoke
    x.execFileSync('xdotool', ['mousedown', '1']);
    for (let i = 1; i <= 6; i++) { x.execFileSync('xdotool', ['mousemove', String(cx - i * 25), String(cy + i * 10)]); await wait(40); }
    x.execFileSync('xdotool', ['mouseup', '1']);
    await wait(300);
    const after = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => /clone/.test(w.webContents.getURL())).getBounds());
    assert.ok(Math.abs(after.x - (h.x - 150)) <= 12 && Math.abs(after.y - (h.y + 60)) <= 12, `moved with the mouse: ${JSON.stringify(after)} from ${JSON.stringify(h)}`);
  }
  fs.writeFileSync(script, JSON.stringify(baseRules));
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

test('smart routing: chat stays on the fast model, specialists run on the strong one', async () => {
  const runs = fs.readFileSync(path.join(userData, 'fake-args.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const model = (a) => (a.includes('--model') ? a[a.indexOf('--model') + 1] : '');
  const by = (m) => runs.filter((a) => model(a) === m).length;
  assert.strictEqual(by('haiku'), 1, "Prime's one warm session is on haiku and was never restarted");
  assert.ok(by('sonnet') >= 2, 'specialists ran on sonnet');
  assert.strictEqual(by('haiku') + by('sonnet'), runs.length, 'no other models');
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
  // The monitor followed the task; a click on the click step outlines that spot on screen.
  const mon = app.windows().find((p) => p.url().includes('/monitor/index.html'));
  assert.ok(mon, 'the agent monitor opened with the task');
  await mon.waitForFunction(() => window.__monitorReady && /Finished/.test(document.getElementById('status').textContent), null, { timeout: 8000 });
  assert.match(await mon.textContent('#goal'), /type a greeting into the box/);
  const labels = await mon.$$eval('#steps li .label', (n) => n.map((x) => x.textContent));
  assert.ok(labels.some((l) => /^Click at/.test(l)) && labels.some((l) => /^Type "hello from the agent"/.test(l)), JSON.stringify(labels));
  await mon.click('#steps li.has-target');
  await wait(400);
  const hl = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('highlight.html')); return w && w.isVisible() ? w.getBounds() : null; });
  assert.ok(hl, 'the highlight is on screen');
  const cxDip = hl.x + hl.width / 2; const cyDip = hl.y + hl.height / 2;
  assert.ok(Math.abs(cxDip - 310) <= 8 && Math.abs(cyDip - 190) <= 8, `outline centred on the clicked spot: ${JSON.stringify(hl)}`);
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
  // What worked can be saved as a reusable desktop playbook (built from the real steps).
  await send('/skill save note-writer');
  await dock.waitForFunction(() => /Saved desktop workflow "note-writer"/.test(document.getElementById('log').innerText), null, { timeout: 8000 });
  const pb = fs.readFileSync(path.join(userData, 'skills', 'note-writer', 'SKILL.md'), 'utf8');
  assert.match(pb, /agent: true/);
  assert.match(pb, /1\. Write notes\.txt/);
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
  assert.match(await cc.textContent('#brains'), /Claude \(haiku\)[\s\S]*ready/, 'the brain router shows each brain and its state');
  assert.match(await cc.textContent('#route-mode'), /automatic/);
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

test('Jev decides non-trivial turns (plain chat is decided locally at once): confident answers steer the model choice', async () => {
  const before = fake.decisions.length;
  assert.ok(before > 0, 'earlier user turns already asked Jev');
  const q = fake.decisions[before - 1];
  assert.strictEqual(q.auth, 'Bearer test-jev-key');
  assert.deepStrictEqual(Object.keys(q.body.questions).sort(), ['acts_on_system', 'complexity', 'effort', 'model', 'specialist', 'task', 'underspecified']);
  assert.strictEqual(Object.keys(q.body.questions.model.criteria).length, 2, 'two eligible models: Claude and the backup');
  const sure = (c, o) => ({ type: 'choice', choice: c, probabilities: { [c]: 0.9, [o]: 0.1 } });
  const crit = q.body.questions.model.criteria;
  const backup = Object.keys(crit).find((k) => /custom OpenAI-compatible/.test(crit[k]));
  fake.jevAnswers = { task: sure('question', 'chat'), complexity: sure('simple', 'complex'), effort: sure('low', 'high'), specialist: sure('none', 'scout'), acts_on_system: { noul: 0.05 }, underspecified: { noul: 0.05 }, model: sure(backup, backup === 'm0' ? 'm1' : 'm0') };
  const chats = fake.chats.length;
  await send('compare the tallest mountains in the alps and the pyrenees in detail and explain why they differ so much in height');
  await dock.waitForFunction(() => /From the backup brain\./.test(document.getElementById('log').innerText), null, { timeout: 15000 });
  assert.strictEqual(fake.chats.length, chats + 1, 'Jev picked the backup model and it answered');
  fake.jevAnswers = null;
  const audit = fs.readFileSync(path.join(userData, 'logs', 'tools.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'route');
  assert.strictEqual(audit.at(-1).source, 'jev');
  assert.strictEqual(audit.at(-1).task, 'question');
});

test('failover with continuity: Claude hits its usage limit mid-conversation, the backup answers with the context, Claude rests', async () => {
  fs.writeFileSync(script, JSON.stringify([
    { match: 'what was my trip budget', error: "You've hit your usage limit · resets 5pm" },
    { match: 'my trip budget is 4200', reply: 'Noted: your trip budget is 4,200.' },
    ...baseRules,
  ]));
  await send('my trip budget is 4200 dollars');
  await dock.waitForFunction(() => /Noted: your trip budget is 4,200\./.test(document.getElementById('log').innerText), null, { timeout: 15000 });
  const chats = fake.chats.length;
  await send('what was my trip budget again?');
  await dock.waitForFunction((n) => /usage limit/i.test(document.getElementById('log').innerText) && document.querySelectorAll('#log .msg.core').length >= n, 1, { timeout: 30000 });
  await dock.waitForFunction(() => (document.getElementById('log').innerText.match(/From the backup brain\./g) || []).length >= 2, null, { timeout: 30000 });
  const handoff = fake.chats[chats];
  const userMsg = handoff.messages.at(-1).content;
  assert.match(userMsg, /\[Earlier in this conversation\][\s\S]*my trip budget is 4200 dollars[\s\S]*Noted: your trip budget is 4,200/, 'the backup got the turns it missed');
  // Next turn: Claude is resting, so the backup answers straight away.
  const spawns = fs.readFileSync(path.join(userData, 'fake-args.log'), 'utf8').trim().split('\n').length;
  await send('thanks, and in euros roughly?');
  await dock.waitForFunction(() => (document.getElementById('log').innerText.match(/From the backup brain\./g) || []).length >= 3, null, { timeout: 15000 });
  assert.strictEqual(fs.readFileSync(path.join(userData, 'fake-args.log'), 'utf8').trim().split('\n').length, spawns, 'Claude was not even started while resting');
  // Changing brain settings gives Claude a fresh chance.
  fs.writeFileSync(script, JSON.stringify(baseRules));
  await settings.evaluate(() => window.settingsApi.set('brain.mode', 'manual'));
  await settings.evaluate(() => window.settingsApi.set('brain.mode', 'auto'));
});

test('memory gateway with the real Cortex: a decision goes to the vault, comes back with its source, and COre answers from it', { skip: !CORTEX_DIR && 'no Cortex checkout' }, async () => {
  fs.writeFileSync(script, JSON.stringify([
    { match: "\\[Knowledge\\][\\s\\S]*glass facade", full: true, reply: 'From your notes in Cortex (Projects/Tower.md): the client chose a glass facade.' },
    { match: 'note the facade decision', reply: 'Noted. [[remember #Tower we decided the client wants a glass facade]]' },
    ...baseRules,
  ]));
  await send('/cortex');
  await dock.waitForFunction(() => /Cortex: connected/.test(document.getElementById('log').innerText), null, { timeout: 20000 });
  await send('note the facade decision');
  await dock.waitForFunction(() => /Saved to Cortex: Projects\/Tower\.md › Decisions/.test(document.getElementById('log').innerText), null, { timeout: 20000 });
  assert.match(fs.readFileSync(path.join(cortexVault, 'Projects', 'Tower.md'), 'utf8'), /we decided the client wants a glass facade/);
  await send('what facade does the tower client want?');
  await dock.waitForFunction(() => /From your notes in Cortex \(Projects\/Tower\.md\)/.test(document.getElementById('log').innerText), null, { timeout: 20000 });
  fs.writeFileSync(script, JSON.stringify(baseRules));
});

test('PHASE 4 ACCEPTANCE: instruction -> knowledge -> specialist -> plan -> tools with a failure and recovery -> verified -> long-term memory', { skip: (process.platform !== 'linux' || !CORTEX_DIR) && 'needs Linux and a Cortex checkout' }, async () => {
  // Knowledge from the earlier Cortex test: Projects/Tower.md says the client wants a glass facade.
  await settings.evaluate(() => window.settingsApi.set('agent.enabled', true));
  fs.writeFileSync(script, JSON.stringify([
    { match: '^(?=[\\s\\S]*\\[Knowledge\\][\\s\\S]*glass facade)(?=[\\s\\S]*which facade)', full: true, reply: 'Per Projects/Tower.md the Tower client chose a glass facade.' },
    { match: 'reply done again', reply: 'Checked: brief.txt has the facade decision. [[act {"type":"done","summary":"facade brief written and checked"}]]' },
    { match: 'Step 3 of', reply: 'Written. [[act {"type":"done","summary":"facade brief written"}]]' },
    { match: 'Step 1 of', reply: 'First, check for an existing brief. [[act {"type":"run","cmd":"node -e process.exit(3)","why":"look for an existing brief"}]]' },
    { match: '^(?=[\\s\\S]*Step 2 of)(?=[\\s\\S]*glass facade)', full: true, reply: 'The check failed, writing the brief from the project notes instead. [[act {"type":"write","path":"brief.txt","text":"Tower facade: glass (client decision, Projects/Tower.md)","why":"save the brief"}]]' },
    ...baseRules,
  ]));
  // 1. A specialist answers from long-term knowledge, routed and recorded.
  await send('@Scout which facade did the Tower client choose?');
  try {
    await dock.waitForFunction(() => [...document.querySelectorAll('.row.by-scout .msg')].some((m) => /Per Projects\/Tower\.md the Tower client chose a glass facade/.test(m.innerText)), null, { timeout: 30000 });
  } catch (err) { console.log('LOG:', (await dock.evaluate(() => document.getElementById('log').innerText)).slice(-1500)); throw err; }
  // 2. A desktop task: a command fails, the agent recovers, writes, re-checks.
  await send('/do write a short Tower facade brief');
  try {
    await dock.waitForFunction(() => !document.getElementById('agent-card').hidden && /Run/.test(document.getElementById('agent-label').textContent), null, { timeout: 30000 });
  } catch (err) { console.log('LOG:', (await dock.evaluate(() => `${document.getElementById('agent-label').textContent} || ${document.getElementById('log').innerText.slice(-800)}`))); throw err; }
  await dock.click('#agent-yes');
  await dock.waitForFunction(() => !document.getElementById('agent-card').hidden && /Write brief\.txt/.test(document.getElementById('agent-label').textContent), null, { timeout: 30000 });
  await dock.click('#agent-yes');
  await dock.waitForFunction(() => /Agent finished: facade brief written and checked/.test(document.getElementById('log').innerText), null, { timeout: 30000 });
  // 3. Verified from the result itself, not the agent's claim.
  assert.strictEqual(fs.readFileSync(path.join(project, 'brief.txt'), 'utf8'), 'Tower facade: glass (client decision, Projects/Tower.md)');
  const audit = fs.readFileSync(path.join(userData, 'logs', 'tools.log'), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  assert.ok(audit.some((e) => e.event === 'agent-command' && /exit\(3\)/.test(JSON.stringify(e.argv))), 'the failing command really ran');
  assert.ok(audit.some((e) => e.event === 'route'), 'turns were routed');
  // 4. The verified outcome is preserved as project knowledge in Cortex.
  const projDir = path.join(cortexVault, 'Projects');
  let found = '';
  for (let i = 0; i < 40 && !found; i++) {
    await wait(250);
    for (const f of fs.existsSync(projDir) ? fs.readdirSync(projDir) : []) { const t = fs.readFileSync(path.join(projDir, f), 'utf8'); if (/Verified on the desktop: facade brief written and checked/.test(t)) found = f; }
  }
  assert.ok(found, 'verified outcome filed in Cortex');
  await settings.evaluate(() => window.settingsApi.set('agent.enabled', false));
  fs.writeFileSync(script, JSON.stringify(baseRules));
});

test('continue: COre knows what it was doing without being told again', async () => {
  fs.writeFileSync(script, JSON.stringify([
    { match: '^(?=[\\s\\S]*\\[Ongoing work\\])(?=[\\s\\S]*write a short Tower facade brief)', full: true, reply: 'Picking up: the Tower facade brief is written and checked.' },
    ...baseRules,
  ]));
  await send('continue');
  await dock.waitForFunction(() => /Picking up: the Tower facade brief is written and checked/.test(document.getElementById('log').innerText), null, { timeout: 20000 });
  fs.writeFileSync(script, JSON.stringify(baseRules));
});

test('suggestions: /suggest lists unfinished work with its source, and changes nothing', async () => {
  await send('/suggest');
  await dock.waitForFunction(() => /Things that may need you \(from what COre can see; nothing has been done\)|Nothing waiting on you right now/.test(document.getElementById('log').innerText), null, { timeout: 15000 });
});

test('diagnostics: /diagnostics reports brain, memory, Cortex, sandbox and automations, without secrets', async () => {
  await send('/diagnostics');
  try {
    await dock.waitForFunction(() => /Diagnostics \(/.test(document.getElementById('log').textContent) && /Command sandbox:/.test(document.getElementById('log').textContent), null, { timeout: 15000 });
  } catch (err) { console.log('LOG:', (await dock.evaluate(() => document.getElementById('log').textContent)).slice(-300)); throw err; }
  const text = await dock.evaluate(() => document.getElementById('log').textContent);
  const report = text.slice(text.lastIndexOf('Diagnostics ('));
  assert.match(report, /Brain \(/); assert.match(report, /Cortex: connected/); assert.match(report, /Automations: files on/);
  assert.doesNotMatch(report, /test-jev-key/, 'no secrets');
});

test('automations: a new file in the project folder starts the matching playbook and the outcome is reported', async () => {
  fs.writeFileSync(script, JSON.stringify([
    { match: '\\[automation CSV intake\\][\\s\\S]*intake-april\\.csv', full: true, reply: 'Intake summary: intake-april.csv has 2 rows.' },
    ...baseRules,
  ]));
  fs.mkdirSync(path.join(userData, 'skills', 'csv-intake'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'skills', 'csv-intake', 'SKILL.md'), '---\nname: csv-intake\ndescription: Summarize a new intake CSV.\nenabled: true\n---\n1. Count the rows\n2. Report the total\n');
  await send('/automations');
  await dock.waitForFunction(() => /Automations: files on/.test(document.getElementById('log').innerText) && /CSV intake: files "intake-\*\.csv" -> csv-intake \(auto\)/.test(document.getElementById('log').innerText), null, { timeout: 8000 });
  await wait(500);
  fs.writeFileSync(path.join(project, 'not-an-intake.csv'), 'a,b\n1,2\n'); // does not match the rule
  fs.writeFileSync(path.join(project, 'intake-april.csv'), 'item,amount\nsteel,9000\nglass,4200\n');
  await dock.waitForFunction(() => /Intake summary: intake-april\.csv has 2 rows/.test(document.getElementById('log').innerText), null, { timeout: 30000 });
  await dock.waitForFunction(() => /CSV intake: File created: intake-april\.csv\. Done \(not verified\)/.test(document.getElementById('log').innerText), null, { timeout: 30000 });
  const hist = JSON.parse(fs.readFileSync(path.join(userData, 'automation-history.json'), 'utf8'));
  const runs = Object.values(hist).flat();
  assert.strictEqual(runs.length, 1, JSON.stringify(hist));
  assert.match(runs[0].what, /intake-april\.csv/);
  fs.writeFileSync(script, JSON.stringify(baseRules));
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

// Invisible design: every window lets the screen show through, so every piece of text must
// either sit on a solid surface or carry the dark halo. Checked over a light, a dark and a
// busy wallpaper; screenshots go to test-e2e/out/ for a human look.
async function unreadable(page) {
  return page.evaluate(() => {
    const bad = [];
    const solid = (el) => { const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(el).backgroundColor); if (!m) return false; const a = m[1].split(',').map(Number); return a.length < 4 || a[3] >= 0.9; };
    for (const el of document.querySelectorAll('body *')) {
      if (['SCRIPT', 'STYLE', 'OPTION', 'SELECT', 'TEXTAREA', 'INPUT', 'svg', 'path'].includes(el.tagName)) continue;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!r.width || !r.height || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      let ok = cs.textShadow && cs.textShadow !== 'none';
      for (let n = el; !ok && n && n !== document.documentElement; n = n.parentElement) ok = solid(n);
      if (!ok) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, '.')}: "${el.textContent.trim().slice(0, 30)}"`);
    }
    return bad;
  });
}
const WALLPAPERS = { light: '#f4f4f0', dark: '#06080b', busy: 'repeating-linear-gradient(45deg, #ffffff 0 14px, #d8343c 14px 28px, #101418 28px 42px, #4aa3ff 42px 56px)' };
test('invisible design: settings, command center, monitor and chat stay readable over any wallpaper', async () => {
  const out = path.join(ROOT, 'test-e2e', 'out');
  fs.mkdirSync(out, { recursive: true });
  await send('/center');
  let center = null;
  for (let i = 0; i < 80 && !center; i++) { center = app.windows().find((p) => p.url().includes('/command/')); if (!center) await wait(250); }
  const pages = { chat: dock, settings, center };
  const mon = app.windows().find((p) => p.url().includes('/monitor/index.html'));
  if (mon) pages.monitor = mon;
  const problems = [];
  for (const [name, page] of Object.entries(pages)) {
    if (!page) { problems.push(`${name}: window not found`); continue; }
    const bad = await unreadable(page);
    if (bad.length) problems.push(`${name}: ${bad.slice(0, 6).join('; ')}`);
    for (const [wp, bg] of Object.entries(WALLPAPERS)) {
      await page.evaluate((bg) => { document.body.classList.add('wallpaper-test'); document.body.style.background = bg; }, bg);
      await page.screenshot({ path: path.join(out, `${name}-${wp}.png`) });
    }
    await page.evaluate(() => { document.body.classList.remove('wallpaper-test'); document.body.style.background = ''; });
  }
  assert.deepStrictEqual(problems, [], `text without a solid backing or halo:\n${problems.join('\n')}`);
});

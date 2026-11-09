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
  const script = path.join(userData, 'fake-script.json');
  fs.writeFileSync(script, JSON.stringify([
    { match: 'remember my tea', reply: 'Got it. [[remember the user likes green tea]]' },
    { match: 'set a tea timer', reply: 'Timer on. [[do timer 10m tea]]' },
    { match: 'rewrite the readme', reply: '{core} here, proposing it.\n\n```txt file=readme.txt\nnew readme from forge\n```' },
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

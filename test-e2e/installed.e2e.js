'use strict';

// INSTALLED-APP ACCEPTANCE: drives the real installed COre (no source tree), two
// separate installations on one machine acting as two devices:
//
//   A: fresh first launch -> bundled Cortex.exe starts -> vault created in Documents
//      -> added to Obsidian's vault list (when Obsidian is installed) -> a decision
//      remembered through the chat lands in the vault -> recalled with its source.
//   B: a second installation with its own data and vault, joined to A's vault by real
//      Syncthing -> recalls A's decision through its own Cortex -> its own decision
//      travels back and A recalls it.
//
// The brain is a local stand-in (scripted replies) so the test is deterministic; it
// only answers from the knowledge COre puts in the prompt, so a recall proves the note
// came back through Cortex.
//
//   CORE_EXE_A=<installed COre.exe> CORE_EXE_B=<second installation> node --test test-e2e/installed.e2e.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { _electron: electron } = require('playwright-core');
const O = require('../src/main/obsidian');
const { Device, until, wait } = require('../test/helpers/syncthing');

const EXE_A = process.env.CORE_EXE_A;
const EXE_B = process.env.CORE_EXE_B;
const skip = !EXE_A || !EXE_B ? 'set CORE_EXE_A and CORE_EXE_B to two installed COre executables' : false;
const evidence = [];
const ok = (what) => { evidence.push(what); console.log(`PASS ${what}`); };

// Stand-in brain (OpenAI-compatible): the first rule whose pattern matches the whole prompt wins.
const RULES = [
  [/\[Knowledge\][\s\S]*terrazzo[\s\S]*|lobby floor[\s\S]*\[Knowledge\][\s\S]*terrazzo/i, /what floor is in the tower lobby/i, 'From your notes in Cortex (Projects/Tower.md): the lobby floor is terrazzo.'],
  [/\[Knowledge\][\s\S]*glass facade/i, /what facade does the tower client want/i, 'From your notes in Cortex (Projects/Tower.md): the client chose a glass facade.'],
  [/note the facade decision/i, null, 'Noted. [[remember #Tower we decided the client wants a glass facade]]'],
  [/note the lobby decision/i, null, 'Noted. [[remember #Tower we decided the lobby floor is terrazzo]]'],
];
function brainServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'stand-in' }] })); return; }
      if (req.url !== '/v1/chat/completions') { res.statusCode = 404; res.end('{}'); return; }
      const j = JSON.parse(body);
      const all = j.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
      const last = String(j.messages[j.messages.length - 1].content || '');
      const rule = RULES.find(([re, ask]) => (ask ? ask.test(last) && re.test(all) : re.test(last)));
      const reply = rule ? rule[2] : 'I do not know that yet.';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function writeConfig(userData, port, extra) {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    orb: { graphics: 'software' },
    brain: { provider: 'openai-compat', fallbacks: [], openaiCompat: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'stand-in', noKey: true }, jev: { enabled: false } },
    voice: { tts: false, wakeWord: false },
    presence: { chitchat: false },
    update: { enabled: false },
    phone: { host: '127.0.0.1', port: 0 },
    ...extra,
  }));
}

async function launch(exe, userData, home) {
  const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${userData}`, '--no-sandbox'], env: { ...process.env, ...(home ? { HOME: home } : {}) }, timeout: 90000 });
  let dock = null;
  for (let i = 0; i < 240 && !dock; i++) { dock = app.windows().find((p) => p.url().includes('/dock/')); if (!dock) await wait(250); }
  if (!dock) throw new Error(`no chat window in ${exe}`);
  await dock.waitForSelector('#input', { state: 'attached', timeout: 60000 });
  return { app, dock };
}
async function say(dock, text) {
  await dock.evaluate(() => { const i = document.getElementById('input'); i.value = ''; });
  await dock.fill('#input', text);
  await dock.press('#input', 'Enter');
}
const logHas = (dock, re, ms = 60000) => dock.waitForFunction((src) => new RegExp(src).test(document.getElementById('log').innerText), re.source, { timeout: ms });
async function quit(app) {
  if (!app) return;
  const proc = app.process();
  await app.evaluate(({ app: a }) => { a.isQuitting = true; a.quit(); }).catch(() => {});
  await Promise.race([new Promise((r) => proc.once('exit', r)), wait(15000)]);
  try { proc.kill(); } catch {}
}

test('INSTALLED APP: first launch -> Cortex -> vault -> Obsidian -> recall; two installations sync through Syncthing', { skip, timeout: 900000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-installed-'));
  const server = await brainServer();
  const port = server.address().port;
  const homeA = process.platform === 'win32' ? null : path.join(root, 'homeA'); // Linux: isolate ~/Documents
  const udA = path.join(root, 'userdata-A');
  const udB = path.join(root, 'userdata-B');
  const vaultB = path.join(root, 'vault-B');
  writeConfig(udA, port, { notify: { enabled: false, port: 47391 } }); // no state.json: a fresh install
  writeConfig(udB, port, { notify: { enabled: false, port: 47392 }, memory: { cortex: { enabled: true, vault: vaultB } } });
  fs.writeFileSync(path.join(udB, 'state.json'), JSON.stringify({ onboarded: true }));
  const sp = 22000 + Math.floor(Math.random() * 20000);
  const SA = new Device(root, 'PC', sp, sp + 1);
  const SB = new Device(root, 'Laptop', sp + 2, sp + 3);
  let A = null, B = null;
  try {
    // ---- A: fresh first launch of the installed app.
    A = await launch(EXE_A, udA, homeA);
    const docs = await A.app.evaluate(({ app }) => app.getPath('documents'));
    const vaultA = path.join(docs, 'COre Vault');
    await until('vault created on first launch', () => fs.existsSync(path.join(vaultA, 'Welcome to COre.md')), 120000);
    await logHas(A.dock, /knowledge vault is ready/);
    ok(`A: first launch created the vault ${vaultA} and turned on the built-in Cortex`);
    if (O.obsidianInstalled()) {
      const list = JSON.parse(fs.readFileSync(O.obsidianConfigPath(), 'utf8'));
      assert.ok(Object.values(list.vaults || {}).some((v) => path.resolve(v.path).toLowerCase() === path.resolve(vaultA).toLowerCase()), 'vault in Obsidian\'s list');
      ok('A: the vault was added to the installed Obsidian\'s vault list');
    } else ok('A: Obsidian not installed here; COre offered /vault obsidian (registration covered on Windows CI)');
    await say(A.dock, '/cortex');
    await logHas(A.dock, /Cortex: connected/, 60000);
    ok('A: the bundled Cortex.exe is connected');
    await say(A.dock, 'note the facade decision');
    await until('decision in vault A', () => /client wants a glass facade/.test(fs.readFileSync(path.join(vaultA, 'Projects', 'Tower.md'), 'utf8')), 60000);
    await say(A.dock, 'what facade does the tower client want?');
    await logHas(A.dock, /From your notes in Cortex \(Projects\/Tower\.md\): the client chose a glass facade/);
    ok('A: a decision remembered through the chat is in Projects/Tower.md and recalled with its source');

    // ---- B: a second installation, joined by Syncthing.
    fs.mkdirSync(vaultB, { recursive: true });
    SA.generate(); SB.generate();
    await SA.start(); await SB.start();
    await SA.share(SB, vaultA); await SB.share(SA, vaultB);
    await until('Tower.md reached device B', () => fs.existsSync(path.join(vaultB, 'Projects', 'Tower.md')) && /glass facade/.test(fs.readFileSync(path.join(vaultB, 'Projects', 'Tower.md'), 'utf8')), 120000);
    ok('Syncthing carried the vault from A to B');
    B = await launch(EXE_B, udB, null);
    await say(B.dock, '/cortex');
    await logHas(B.dock, /Cortex: connected/, 60000);
    await say(B.dock, 'what facade does the tower client want?');
    await logHas(B.dock, /From your notes in Cortex \(Projects\/Tower\.md\): the client chose a glass facade/);
    ok('B: the second installation recalls A\'s decision through its own Cortex');
    await say(B.dock, 'note the lobby decision');
    await until('B decision in vault B', () => /lobby floor is terrazzo/.test(fs.readFileSync(path.join(vaultB, 'Projects', 'Tower.md'), 'utf8')), 60000);
    await until('B decision reached A', () => /lobby floor is terrazzo/.test(fs.readFileSync(path.join(vaultA, 'Projects', 'Tower.md'), 'utf8')), 120000);
    await wait(2500); // Cortex re-checks changed files at most every 2 s
    await say(A.dock, 'what floor is in the tower lobby?');
    await logHas(A.dock, /lobby floor is terrazzo/);
    ok('B -> A: B\'s decision travelled back and A recalls it');
    if (process.env.INSTALLED_EVIDENCE) fs.writeFileSync(process.env.INSTALLED_EVIDENCE, `${evidence.join('\n')}\n`);
  } finally {
    await quit(A && A.app); await quit(B && B.app);
    await SA.stop().catch(() => {}); await SB.stop().catch(() => {});
    server.close();
  }
});

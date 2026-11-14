#!/usr/bin/env node
'use strict';
// Companion simulation (T2): the REAL app with a REAL model (Groq, falling back to Gemini and
// OpenRouter; keys come from the environment's network proxy), driven through a day of ordinary
// companion use. Every exchange is recorded and checked for the failures a user notices:
// errors, leaked internal markup, empty or very slow replies, memory that does not stick (or does
// not go away), repeated answers, and crashes in the app's processes.
//
//   xvfb-run node scripts/companion-sim.js [--out eval/results/companion-sim.md] [--turns N]
//
// It needs a display (Xvfb on Linux). Free model tiers rate-limit, so turns are spaced out.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : '';
const MAX = process.argv.includes('--turns') ? Number(process.argv[process.argv.indexOf('--turns') + 1]) : Infinity;
const FROM = process.argv.includes('--from') ? Number(process.argv[process.argv.indexOf('--from') + 1]) : 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Each turn: what the user says, and what a good answer must (re) / must not (not) contain.
const TURNS = [
  { say: 'hi COre, how are you today?' },
  { say: 'what can you help me with?' },
  { say: "remember that my sister Aina's birthday is on 12 December", re: /remember|noted|got it|saved|12 december/i },
  { say: "when is Aina's birthday?", re: /12(th)? dec/i },
  { say: 'set a timer for 5 minutes for tea', re: /timer|5 min/i },
  { say: 'remind me tomorrow at 9am to call the contractor', re: /remind|9/i },
  { say: 'what time is it right now?', re: /\d{1,2}[:.]\d{2}|o'?clock/i },
  { say: "what's on my calendar today?", re: /calendar|feed|connect|nothing/i },
  { say: 'tell me a short joke' },
  { say: '@Scout find three good free note-taking apps for Windows', wait: 90000 },
  { say: 'summarize what we talked about so far in two sentences' },
  { say: 'translate "good morning, how are you" into Malay', re: /selamat pagi/i },
  { say: 'boleh tolong tulis email ringkas kepada bos saya untuk minta cuti esok?', re: /cuti|tuan|puan|bos|esok/i },
  { say: '/do open my downloads folder', re: /off|settings|enable|agent|operate/i },
  { say: 'what did I ask you to remember earlier?', re: /aina|birthday|12/i },
  { say: "forget Aina's birthday", re: /forg|remov|deleted|done/i },
  { say: "when is Aina's birthday?", not: /12(th)? dec/i },
  { say: '/briefing' },
  { say: '/diagnostics' },
  { say: 'thanks, that is all for now' },
].slice(FROM, FROM + MAX);

const LEAK = [/\[\[/, /\]\]/, /<<\s*untrusted/i, /\[object Object\]/, /\bundefined\b/, /^\s*\{\s*"/m, /\[(idle|mission-plan|Memory stats|Knowledge|Files on the shelf)\]/i, /TypeError|ReferenceError|at .*\.js:\d+/];

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'core-sim-home-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'core-sim-ud-'));
  const key = 'plain:proxy-injected'; // the network proxy puts the real key in the header
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    orb: { graphics: 'software' },
    brain: { provider: 'groq', mode: 'manual', fallbacks: ['gemini', 'openrouter'], secrets: { groq: key, gemini: key, openrouter: key }, jev: { enabled: false } },
    voice: { tts: false },
    presence: { chitchat: false, briefing: false },
    update: { enabled: false },
    phone: { host: '127.0.0.1', port: 0 },
  }));
  fs.writeFileSync(path.join(userData, 'state.json'), JSON.stringify({ onboarded: true }));
  const mainErrors = [];
  const app = await electron.launch({
    args: ['--no-sandbox', ROOT, `--user-data-dir=${userData}`],
    cwd: ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, NODE_USE_ENV_PROXY: '1', NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || '/root/.ccr/ca-bundle.crt' },
    timeout: 60000,
  });
  app.process().stderr.on('data', (d) => { const t = String(d); if (/error|exception|unhandled|TypeError|ReferenceError/i.test(t) && !/GPU|gpu_|dbus|libva|Fontconfig|ALSA|DevTools|ozone|viz_|cc_|vaInit/i.test(t)) mainErrors.push(t.trim().slice(0, 400)); });
  let dock = null;
  for (let i = 0; i < 120 && !dock; i++) { dock = app.windows().find((w) => w.url().includes('/dock/')); if (!dock) await wait(250); }
  if (!dock) throw new Error('no dock window');
  const pageErrors = [];
  dock.on('pageerror', (e) => pageErrors.push(e.message));
  await dock.waitForSelector('#input', { state: 'attached' });
  await wait(2500);
  const logText = () => dock.evaluate(() => document.getElementById('log').innerText);

  const results = [];
  for (const t of TURNS) {
    const before = await logText();
    const t0 = Date.now();
    await dock.evaluate(() => { const i = document.getElementById('input'); i.focus(); });
    await dock.fill('#input', t.say);
    await dock.press('#input', 'Enter');
    // A reply is finished when the log has grown and then stayed the same for 3 s.
    let last = before, stableSince = 0, firstChange = 0;
    const limit = t.wait || 60000;
    while (Date.now() - t0 < limit) {
      await wait(300);
      const now = await logText();
      if (now !== last) { last = now; stableSince = Date.now(); if (!firstChange && now.replace(t.say, '').length > before.length + 2) firstChange = Date.now(); continue; }
      if (firstChange && Date.now() - stableSince > 3000) break;
    }
    // What this turn added to the chat (the log only grows), minus the echo of what was said.
    let added = last.length >= before.length && last.startsWith(before.slice(0, 200)) ? last.slice(before.length) : last.slice(-2000);
    added = added.replace(t.say, '').trim();
    const ms = (firstChange || Date.now()) - t0;
    const issues = [];
    if (!firstChange) issues.push(`no reply within ${Math.round(limit / 1000)} s`);
    if (firstChange && !added) issues.push('empty reply');
    for (const re of LEAK) if (re.test(added)) issues.push(`leaked internal text (${re})`);
    if (t.re && !t.re.test(added)) issues.push(`expected ${t.re}`);
    if (t.not && t.not.test(added)) issues.push(`should not contain ${t.not}`);
    if (/could not answer|went wrong|failed|error/i.test(added) && !/^\/diag/.test(t.say)) issues.push('reports a failure');
    if (ms > 20000 && !t.wait) issues.push(`slow first reply (${Math.round(ms / 1000)} s)`);
    const prev = results[results.length - 1];
    if (prev && added && prev.reply === added) issues.push('same reply as the previous turn');
    results.push({ say: t.say, reply: added, ms, issues });
    process.stdout.write(`${issues.length ? '✗' : '✓'} ${t.say.slice(0, 60)} (${Math.round(ms / 100) / 10} s)${issues.length ? ` — ${issues.join('; ')}` : ''}\n`);
    await wait(4000); // free tiers rate-limit
  }
  const proc = app.process();
  await app.evaluate(({ app: a }) => { a.isQuitting = true; a.quit(); }).catch(() => {});
  await Promise.race([new Promise((r) => proc.once('exit', r)), wait(10000)]);
  if (proc.exitCode === null) proc.kill('SIGKILL');

  const bad = results.filter((r) => r.issues.length);
  const lines = [
    `# Companion simulation (${new Date().toISOString().slice(0, 10)})`, '',
    'Tier **T2**: the real app on Linux (Xvfb) with a real model (Groq, falling back to Gemini/OpenRouter on free tiers), driven through ordinary companion use. Checks are automatic; every reply is also listed for reading.', '',
    `**${results.length - bad.length} of ${results.length} turns without a detected problem.** App errors: ${mainErrors.length} main-process, ${pageErrors.length} chat window.`, '',
    '| # | You said | Time to first reply | Problems |', '|---|---|---|---|',
    ...results.map((r, i) => `| ${i + 1} | ${r.say.replace(/\|/g, '\\|')} | ${(r.ms / 1000).toFixed(1)} s | ${r.issues.join('; ').replace(/\|/g, '\\|') || '—'} |`), '',
    '## Replies', '',
    ...results.flatMap((r, i) => [`**${i + 1}. ${r.say}**`, '', '```', r.reply.slice(0, 1500), '```', '']),
    ...(mainErrors.length ? ['## Main-process errors', '', '```', ...mainErrors.slice(0, 20), '```', ''] : []),
    ...(pageErrors.length ? ['## Chat window errors', '', '```', ...pageErrors.slice(0, 20), '```', ''] : []),
  ];
  if (OUT) { fs.writeFileSync(path.join(ROOT, OUT), lines.join('\n')); console.log(`wrote ${OUT}`); }
  console.log(`\n${results.length - bad.length}/${results.length} clean; main errors ${mainErrors.length}; page errors ${pageErrors.length}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

#!/usr/bin/env node
'use strict';
// Companion simulation (T2): the REAL app with a REAL model (Groq, falling back to Gemini and
// OpenRouter; keys come from the environment's network proxy), driven through a day of ordinary
// companion use. Every exchange is recorded and checked for the failures a user notices:
// errors, leaked internal markup, empty or very slow replies, memory that does not stick (or does
// not go away), repeated answers, and crashes in the app's processes.
//
//   xvfb-run node scripts/companion-sim.js [--out eval/results/companion-sim.md] [--turns N] [--from I] [--provider gemini]
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
const PROVIDER = process.argv.includes('--provider') ? process.argv[process.argv.indexOf('--provider') + 1] : 'groq';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Each turn: what the user says, and what a good answer must (re) / must not (not) contain.
// interrupt: send the next message after this many ms instead of waiting for the reply.
const FACTS = [
  ['my car is a blue Proton X50', 'what car do I drive?', /proton|x50/i],
  ['my dentist appointment is on the 3rd of March', 'when is my dentist appointment?', /3(rd)?\s*(of\s*)?march|march\s*3/i],
  ["my cat's name is Mochi", "what's my cat called?", /mochi/i],
  ['I work as a civil engineer in Penang', 'what is my job?', /civil engineer/i],
  ['my favourite food is nasi lemak', 'what food do I like most?', /nasi lemak/i],
];
const FILLER = ['give me a synonym for happy', 'what is 17 times 23?', 'name a planet with rings', 'what is the capital of Japan?',
  'how many legs does a spider have?', 'spell "necessary" backwards', 'what colour do you get mixing blue and yellow?',
  'give me one tip for better sleep', 'what is the boiling point of water in Fahrenheit?', 'name three fruits that are red',
  'what is the square root of 144?', 'who wrote Romeo and Juliet?', 'translate "thank you" into Japanese', 'what is a haiku?',
  'how many minutes are in a day?', 'name a famous bridge in San Francisco', 'what does CPU stand for?',
  'give me a word that rhymes with orange, if any', 'how many continents are there?', 'what is the largest ocean?',
  'what is 2 to the power of 10?', 'name an animal that lives in the Arctic', 'what language is spoken in Brazil?',
  'what is the opposite of ancient?', 'what gas do plants breathe in?'];
const SETS = {
  everyday: [
  { say: 'hi COre, how are you today?' },
  { say: 'what can you help me with?' },
  { say: "remember that my sister Aina's birthday is on 12 December", re: /remember|noted|got it|saved|12 december/i },
  { say: "when is Aina's birthday?", re: /12(th)?\s*dec|dec\w*\s*12/i },
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
  { say: "when is Aina's birthday?", not: /12(th)?\s*dec|dec\w*\s*12/i },
  { say: '/briefing' },
  { say: '/diagnostics' },
  { say: 'thanks, that is all for now' },
],
  skills: [
    // A real forecast, or an honest "couldn't get the weather" (this sandbox's proxy breaks the TLS of
    // the weather service), never an invented one (the service sends no humidity; a model making it up does).
    { say: "what's the weather in Kuala Lumpur today?", re: /percent chance of rain|% rain|couldn'?t get the weather/i, not: /humidity/i, wait: 45000 },
    { say: 'save a note: buy milk, eggs and bread', re: /note|saved|got it|added/i },
    { say: 'what notes do I have about milk?', re: /milk/i, wait: 45000 },
    { say: 'search the web for the best budget laptop this year', re: /search|button|open|results/i },
    { say: 'open the calculator', re: /calculator|open|can'?t|not available|couldn'?t/i },
    { say: 'pause the music', re: /paus|music|nothing|player/i },
    { say: 'how long until 5pm?', re: /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half an?)\s*(hours?|minutes?|h\b|min)|passed|already/i },
    { say: 'what day of the week is 25 December 2026?', re: /friday/i },
    { say: 'set a timer for 90 seconds called pasta', re: /timer|90|minute|pasta/i },
    { say: 'how long is left on my timers?', re: /pasta|left|minute|second|no timers/i },
  ],
  long: [
    ...FACTS.map(([fact]) => ({ say: `remember that ${fact}`, re: /remember|noted|got it|saved|updated/i })),
    ...FILLER.map((say) => ({ say })),
    ...FACTS.map(([, q, re]) => ({ say: q, re })),
  ],
  specialists: [
    { say: '@Forge draft a short README.md for a tiny todo-list app', wait: 120000 },
    { say: '@Sentinel review this function for bugs: function add(a, b) { return a - b; }', re: /subtract|minus|-|bug|wrong|should/i, wait: 120000 },
    { say: '@Scout compare Python and JavaScript for a complete beginner', interrupt: 2500 },
    { say: '/stop @Scout', re: /stopped/i },
    { say: 'hi COre, are you still with me?', re: /\w/ },
    { say: 'which specialists do you have?', re: /scout|forge|sentinel/i },
  ],
  interrupt: [
    { say: 'write me a 600-word story about a dragon who loves tea', interrupt: 2500 },
    { say: 'actually, stop that. just tell me a one-line joke instead', re: /\w/ },
    { say: 'what was the last thing I asked you for?', re: /joke/i },
    { say: 'explain quantum computing in detail', interrupt: 1200 },
    { say: 'never mind. what is 9 plus 10?', re: /19|nineteen/i },
  ],
  outage: [
    { say: 'hi COre, are you there?', re: /rate|limit|could not|couldn'?t|no brain|busy|try again|unavailable|connect/i, wait: 45000 },
    { say: 'hello? anyone?', re: /rate|limit|could not|couldn'?t|no brain|busy|try again|unavailable|connect/i, wait: 45000 },
    { say: 'what time is it?', re: /\d{1,2}[:.]\d{2}/ },
    { say: 'set a timer for 90 seconds called pasta', re: /timer set: pasta/i },
    { say: 'hello again', re: /all your brains are rate limited/i, not: /connect another brain/i, wait: 45000 },
  ],
};
const SET = process.argv.includes('--set') ? process.argv[process.argv.indexOf('--set') + 1] : 'everyday';
if (!SETS[SET]) { console.error(`unknown --set ${SET}; one of ${Object.keys(SETS).join(', ')}`); process.exit(2); }
const TURNS = SETS[SET].slice(FROM, FROM + MAX);

const LEAK = [/\[\[\s*[a-z]+\b[^\]]*\]\]/i, /\[\[\s*(remember|forget|remind|do|gesture|mood|point|form|board|delegate|open|copy)\b/i, /<<\s*untrusted/i, /\[object Object\]/, /\bundefined\b/, /^\s*\{\s*"/m, /\[(idle|mission-plan|Memory stats|Knowledge|Files on the shelf)\]/i, /^\s*(TypeError|ReferenceError): |\n\s+at .+\(.+\.js:\d+:\d+\)/m];

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'core-sim-home-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'core-sim-ud-'));
  // outage: every provider points at a local server that only answers 429 (rate limited).
  let fake = null; let brainUrls = {};
  if (SET === 'outage') {
    fake = require('http').createServer((req, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' }); res.end('{"error":{"message":"rate limited"}}'); });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${fake.address().port}/v1`;
    brainUrls = { groq: { baseUrl: url, model: 'm' }, gemini: { baseUrl: url, model: 'm' }, openrouter: { baseUrl: url, model: 'm' } };
  }
  const key = 'plain:proxy-injected'; // the network proxy puts the real key in the header
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    orb: { graphics: 'software' },
    brain: { provider: PROVIDER, mode: 'manual', fallbacks: ['groq', 'gemini', 'openrouter'].filter((p) => p !== PROVIDER), secrets: { groq: key, gemini: key, openrouter: key }, jev: { enabled: false }, ...brainUrls },
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
  if (process.env.SIM_LOG) { const log = fs.createWriteStream(process.env.SIM_LOG); app.process().stdout.pipe(log); app.process().stderr.pipe(log); }
  app.process().stderr.on('data', (d) => { const t = String(d); if (/error|exception|unhandled|TypeError|ReferenceError/i.test(t) && !/GPU|gpu_|dbus|libva|Fontconfig|ALSA|DevTools|ozone|viz_|cc_|vaInit/i.test(t)) mainErrors.push(t.trim().slice(0, 400)); });
  let dock = null;
  for (let i = 0; i < 120 && !dock; i++) { dock = app.windows().find((w) => w.url().includes('/dock/')); if (!dock) await wait(250); }
  if (!dock) throw new Error('no dock window');
  const pageErrors = [];
  dock.on('pageerror', (e) => pageErrors.push(e.message));
  await dock.waitForSelector('#input', { state: 'attached' });
  await wait(2500);
  // The chat drops old messages, so the log's length says nothing; each turn marks the messages
  // already shown and reads only the new ones (the reply, minus the echo of what was said).
  const markSeen = () => dock.evaluate(() => { for (const el of document.getElementById('log').children) { el.dataset.simSeen = '1'; el.dataset.simText = el.innerText; } });
  // COre's earlier replies that kept growing after you moved on (an interrupted answer that kept streaming;
  // up to 300 characters were already on their way when the message was sent).
  const changedEarlier = () => dock.evaluate(() => [...document.getElementById('log').querySelectorAll('.row.by-prime[data-sim-seen]')].filter((el) => el.innerText.length - el.dataset.simText.length > 300).map((el) => `${el.innerText.length - el.dataset.simText.length} characters added, ending "${el.innerText.slice(-80)}"`));
  const newText = () => dock.evaluate(() => [...document.getElementById('log').children].filter((el) => !el.dataset.simSeen).map((el) => el.innerText).join('\n'));

  const results = [];
  for (const t of TURNS) {
    await markSeen();
    const t0 = Date.now();
    await dock.evaluate(() => { const i = document.getElementById('input'); i.focus(); });
    await dock.fill('#input', t.say);
    await dock.press('#input', 'Enter');
    if (t.interrupt) {
      await wait(t.interrupt);
      results.push({ say: t.say, reply: (await newText()).replace(t.say, '').trim(), ms: t.interrupt, issues: [], interrupted: true });
      process.stdout.write(`… ${t.say.slice(0, 60)} (interrupted after ${t.interrupt / 1000} s)\n`);
      continue;
    }
    // A reply is finished when something new appeared and then stayed the same for 3 s.
    let last = '', stableSince = 0, firstChange = 0;
    // "@Forge ...": the turn is the specialist's answer, not the "split off" note.
    const who = (/^@(\w+)/.exec(t.say) || [])[1]; const whoId = who && who.toLowerCase();
    const limit = t.wait || 60000;
    const strip = (x) => x.replace(t.say, '').replace(t.say.replace(/^@\w+\s+/, ''), '').trim();
    while (Date.now() - t0 < limit) {
      await wait(300);
      const now = await newText();
      if (now !== last) { last = now; stableSince = Date.now(); if (!firstChange && strip(now)) firstChange = Date.now(); continue; }
      // ...and COre is no longer thinking (a lookup like the calendar answers in a second step).
      if (firstChange && Date.now() - stableSince > 3000 && (!whoId || await dock.evaluate((w) => [...document.getElementById('log').querySelectorAll(`.row.by-${w}`)].some((el) => !el.dataset.simSeen), whoId)) && !(await dock.evaluate(() => (document.getElementById('head-status') || {}).textContent === 'Thinking…'))) break;
    }
    const added = strip(last);
    const ms = (firstChange || Date.now()) - t0;
    const issues = [];
    if (!firstChange) issues.push(`no reply within ${Math.round(limit / 1000)} s`);
    if (firstChange && !added) issues.push('empty reply');
    for (const re of LEAK) if (re.test(added)) issues.push(`leaked internal text (${re})`);
    if (t.re && !t.re.test(added)) issues.push(`expected ${t.re}`);
    if (t.not && t.not.test(added)) issues.push(`should not contain ${t.not}`);
    if (/could not answer|went wrong|failed|error/i.test(added.split('\n').filter((l) => !/Switching to /.test(l)).join('\n')) && !/^(\/diag|@)/.test(t.say)) issues.push('reports a failure');
    if (ms > 20000 && !t.wait) issues.push(`slow first reply (${Math.round(ms / 1000)} s)`);
    const moved = await changedEarlier();
    if (moved.length) issues.push(`an earlier reply kept changing after this message (${JSON.stringify(moved[0])})`);
    const prev = results[results.length - 1];
    if (prev && added && prev.reply === added) issues.push('same reply as the previous turn');
    results.push({ say: t.say, reply: added, ms, issues });
    process.stdout.write(`${issues.length ? '✗' : '✓'} ${t.say.slice(0, 60)} (${Math.round(ms / 100) / 10} s)${issues.length ? ` — ${issues.join('; ')}` : ''}\n`);
    await wait(4000); // free tiers rate-limit
  }
  if (fake) fake.close();
  const proc = app.process();
  await app.evaluate(({ app: a }) => { a.isQuitting = true; a.quit(); }).catch(() => {});
  await Promise.race([new Promise((r) => proc.once('exit', r)), wait(10000)]);
  if (proc.exitCode === null) proc.kill('SIGKILL');

  const bad = results.filter((r) => r.issues.length);
  const lines = [
    `# Companion simulation: ${SET} (${new Date().toISOString().slice(0, 10)}, ${PROVIDER} first)`, '',
    'Tier **T2**: the real app on Linux (Xvfb) with a real model (Groq, falling back to Gemini/OpenRouter on free tiers), driven through ordinary companion use. Checks are automatic; every reply is also listed for reading.', '',
    `**${results.length - bad.length} of ${results.length} turns without a detected problem.** App errors: ${mainErrors.length} main-process, ${pageErrors.length} chat window.`, '',
    '| # | You said | Time to first reply | Problems |', '|---|---|---|---|',
    ...results.map((r, i) => `| ${i + 1} | ${r.say.replace(/\|/g, '\\|')} | ${(r.ms / 1000).toFixed(1)} s | ${r.issues.join('; ').replace(/\|/g, '\\|') || '—'} |`), '',
    '## Replies', '',
    ...results.flatMap((r, i) => [`**${i + 1}. ${r.say}**`, '', '```', r.reply.slice(0, 1500), '```', '']),
    ...(mainErrors.length ? ['## Main-process errors', '', '```', ...mainErrors.slice(0, 20), '```', ''] : []),
    ...(pageErrors.length ? ['## Chat window errors', '', '```', ...pageErrors.slice(0, 20), '```', ''] : []),
  ];
  if (OUT) { fs.writeFileSync(path.resolve(ROOT, OUT), lines.join('\n')); console.log(`wrote ${OUT}`); }
  console.log(`\n${results.length - bad.length}/${results.length} clean; main errors ${mainErrors.length}; page errors ${pageErrors.length}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

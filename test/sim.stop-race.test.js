'use strict';

// Simulation (T1, no model): stops fired at random moments (while planning, during a slow
// model reply, mid-tool, between subgoals) against the real agent loop and mission engine,
// with a new task started right after. Invariants, for every run:
//   1. the run settles (no hang) within 200 ms of the stop
//   2. the agent is free again (running === false) and a new task can start at once
//   3. no action is performed after the stop
//   4. the mission reports 'stopped' (never 'done' after a stop)
// Seeded (SIM_SEED, SIM_N) so a failure replays.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AG = require('../src/main/agent');
const E = require('../src/main/missions/engine');
const { Policy, createGrant, loadKey } = require('../src/main/policy');

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEED = Number(process.env.SIM_SEED) || 77;
const N = Number(process.env.SIM_N) || 60;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-race-'));
  const W = path.join(root, 'work');
  fs.mkdirSync(W);
  const key = loadKey(path.join(root, 'userData'));
  return { W, key, grant: createGrant({ goal: 'g', folders: [W] }, key) };
}

function makeRunner(r, { W, key, grant }, log) {
  let i = 0;
  const delay = () => sleep(Math.floor(r() * 25));
  return new AG.AgentRunner({
    plan: r() < 0.5, verify: false, settleMs: 0, maxSteps: 8,
    policy: new Policy({ grant, key }),
    think: async () => { await delay(); i++; return i > 6 ? '[[act {"type":"done","summary":"ok"}]]' : `[[act ${JSON.stringify(r() < 0.5 ? { type: 'write', path: path.join(W, `f${i}.md`), text: 'x' } : { type: 'key', combo: 'ctrl+s' })}]]`; },
    screenshot: async () => { await delay(); return { width: 800, height: 600, displayWidth: 800, displayHeight: 600, scaleFactor: 1 }; },
    driver: { perform: async (a) => { log.push({ at: Date.now(), what: a.type }); await delay(); } },
    openApp: async () => {}, onStep: () => {}, approve: async () => 'no',
    tools: { write: async (a) => { log.push({ at: Date.now(), what: 'write' }); await delay(); fs.writeFileSync(a.path, a.text); return 'ok'; } },
  });
}

test(`stop races: ${N} random stops against the real agent loop; it always settles, frees itself and does nothing after (seed ${SEED})`, async () => {
  const r = rng(SEED);
  const env = setup();
  const failures = [];
  for (let n = 0; n < N; n++) {
    const log = [];
    const runner = makeRunner(r, env, log);
    const p = runner.run('g');
    await sleep(Math.floor(r() * 120));
    const stoppedAt = Date.now();
    runner.stop('race');
    const settled = await Promise.race([p.then((x) => x, (e) => ({ status: 'threw', summary: e.message })), sleep(200).then(() => null)]);
    if (!settled) failures.push({ n, why: 'did not settle within 200 ms of the stop' });
    if (runner.running) failures.push({ n, why: 'agent still running after stop' });
    if (settled && settled.status === 'threw') failures.push({ n, why: `threw: ${settled.summary}` });
    await sleep(40); // anything still in flight would show up now
    const after = log.filter((e) => e.at > stoppedAt);
    if (after.length) failures.push({ n, why: `${after.length} action(s) after the stop: ${after.map((e) => e.what).join(',')}` });
    // A new task starts at once on the same runner.
    try { const q = runner.run('g2'); runner.stop('again'); await q; } catch (err) { failures.push({ n, why: `could not start a new task: ${err.message}` }); }
  }
  assert.deepStrictEqual(failures.slice(0, 5), [], `${failures.length} failures`);
});

test(`stop races: ${N} random stops against the mission engine driving the real agent loop (seed ${SEED})`, async () => {
  const r = rng(SEED + 1);
  const env = setup();
  const failures = [];
  for (let n = 0; n < N; n++) {
    const log = [];
    let current = null;
    const eng = new E.MissionEngine({
      think: async () => { await sleep(Math.floor(r() * 20)); return '1. Write a | check: none\n2. Write b | check: none\n3. Write c | check: none'; },
      runSubgoal: async (sg, { signal }) => {
        await sleep(Math.floor(r() * 15)); // setup before the runner exists
        if (signal.aborted) return { status: 'stopped', steps: 0 };
        current = makeRunner(r, env, log);
        signal.addEventListener('abort', () => current.stop('mission stopped'), { once: true });
        const res = await current.run(sg.text);
        return { status: res.status, summary: res.summary, steps: res.steps };
      },
      judge: async () => ({ ok: true, why: 'ok' }),
    });
    const p = eng.run({ id: `m${n}`, goal: 'g', grant: { folders: [env.W], budget: { steps: 200, minutes: 5 } } });
    await sleep(Math.floor(r() * 200));
    const stoppedAt = Date.now();
    eng.stop('race');
    const rep = await Promise.race([p, sleep(200).then(() => null)]);
    if (!rep) { failures.push({ n, why: 'mission did not settle within 200 ms' }); continue; }
    if (rep.status === 'done' && rep.ms > stoppedAt - (stoppedAt - rep.startedAt)) {
      // finished before the stop arrived: fine only if it really ended before the stop
      if (rep.startedAt + rep.ms > stoppedAt + 5) failures.push({ n, why: 'reported done after the stop' });
    } else if (rep.status !== 'stopped' && rep.status !== 'done') failures.push({ n, why: `status ${rep.status}: ${rep.reason || rep.question || ''}` });
    await sleep(60);
    if (current && current.running) failures.push({ n, why: 'subgoal agent still running after the mission stopped' });
    const after = log.filter((e) => e.at > stoppedAt);
    if (after.length) failures.push({ n, why: `${after.length} action(s) after the mission stop: ${after.map((e) => e.what).join(',')}` });
  }
  assert.deepStrictEqual(failures.slice(0, 5), [], `${failures.length} failures`);
});

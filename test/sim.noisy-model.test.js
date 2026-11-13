'use strict';

// Simulation (T1, no model): the mission engine driven by an unreliable "model": per
// attempt it either does the work, falsely claims it is done, fails, throws, asks, or burns
// steps. Plans have deterministic file checks. Invariants over every mission:
//   1. a subgoal is marked done only if its check really holds on disk (false "done" claims
//      are caught 100% of the time when a check exists)
//   2. a mission is 'done' only if every check holds
//   3. no subgoal gets more than two attempts; a mission that can't finish asks or stops at
//      its budget, never loops
//   4. the step budget is never exceeded by more than one subgoal's steps
// Seeded (SIM_SEED, SIM_N).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../src/main/missions/engine');
const { check } = require('../src/main/missions/checks');

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const SEED = Number(process.env.SIM_SEED) || 4242;
const N = Number(process.env.SIM_N) || 400;

test(`noisy model: ${N} missions; false "done" claims never pass verification; no loops; budgets hold (seed ${SEED})`, async () => {
  const r = rng(SEED);
  const failures = [];
  const stats = { falseClaims: 0, done: 0, ask: 0, limit: 0, failed: 0 };
  for (let n = 0; n < N; n++) {
    const W = fs.mkdtempSync(path.join(os.tmpdir(), 'core-noisy-'));
    const k = 1 + Math.floor(r() * 4);
    const plan = Array.from({ length: k }, (_, i) => r() < 0.5 ? `${i + 1}. Write f${i}.md | check: contains f${i}.md :: alpha beta` : `${i + 1}. Make f${i}.md | check: exists f${i}.md`).join('\n');
    const budget = { steps: 10 + Math.floor(r() * 40), minutes: 5 };
    let maxSubSteps = 0;
    const attempts = {};
    const claimed = new Set();
    const eng = new E.MissionEngine({
      think: async () => plan,
      runSubgoal: async (sg, { index }) => {
        attempts[index] = (attempts[index] || 0) + 1;
        const steps = 1 + Math.floor(r() * (r() < 0.1 ? 30 : 5));
        maxSubSteps = Math.max(maxSubSteps, steps);
        const x = r();
        if (x < 0.45) { fs.writeFileSync(path.join(W, `f${index}.md`), 'alpha and beta'); return { status: 'done', summary: 'did it', steps }; }
        if (x < 0.55) { fs.writeFileSync(path.join(W, `f${index}.md`), 'beta only'); claimed.add(`${index}:${attempts[index]}`); stats.falseClaims++; return { status: 'done', summary: 'done (half)', steps }; }
        if (x < 0.75) { claimed.add(`${index}:${attempts[index]}`); stats.falseClaims++; return { status: 'done', summary: 'done!', steps }; } // claims, did nothing
        if (x < 0.85) return { status: 'failed', summary: 'could not', steps };
        if (x < 0.92) throw new Error('model error');
        if (x < 0.96) return { status: 'ask', summary: 'which folder?', steps };
        return { status: 'done', summary: 'did it', steps: Array.from({ length: steps }, () => ({})) }; // steps as a list, nothing written
      },
      judge: async () => ({ ok: true, why: 'trust me' }), // a gullible judge: must never be consulted when a check exists
    });
    const rep = await eng.run({ id: `m${n}`, goal: 'g', grant: { folders: [W], budget } });
    stats[rep.status] = (stats[rep.status] || 0) + 1;
    rep.subgoals.forEach((sg, i) => {
      const holds = sg.check ? check(W, sg.check).ok : null;
      if (sg.status === 'done' && sg.check && !holds) failures.push({ n, why: `subgoal ${i} marked done but its check fails`, check: sg.check });
      if (sg.status === 'done' && sg.evidence && sg.evidence.kind === 'judged' && sg.check) failures.push({ n, why: 'judge used although a check exists' });
      if ((attempts[i] || 0) > 2) failures.push({ n, why: `subgoal ${i} attempted ${attempts[i]} times` });
    });
    if (rep.status === 'done' && rep.subgoals.some((sg) => sg.check && !check(W, sg.check).ok)) failures.push({ n, why: 'mission done with a failing check' });
    if (rep.steps > budget.steps + maxSubSteps) failures.push({ n, why: `steps ${rep.steps} beyond budget ${budget.steps} + ${maxSubSteps}` });
    if (!['done', 'ask', 'limit', 'failed', 'stopped'].includes(rep.status)) failures.push({ n, why: `odd status ${rep.status}` });
  }
  assert.deepStrictEqual(failures.slice(0, 5), [], `${failures.length} failures; ${JSON.stringify(stats)}`);
  assert.ok(stats.falseClaims > 50 && stats.done > 20 && stats.ask > 20, `the simulation exercised every path: ${JSON.stringify(stats)}`);
  console.log(`noisy-model sim: ${JSON.stringify(stats)}`);
});

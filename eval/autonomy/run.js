#!/usr/bin/env node
'use strict';

// Run the autonomy evaluation.
//   node eval/autonomy/run.js --adapter oracle|noop|agent12 [--tier T2] [--only id,id] [--category files]
//        [--limit N] [--out eval/results/<file>.md] [--approve every|task-auto] [--provider groq]
// Results are labelled with the adapter and tier; see docs/dev/PLAN-13.0.md section 5.

const fs = require('fs');
const path = require('path');
const H = require('./lib/harness');
const { ALL } = require('./tasks');
const { byId } = require('../security/injections');
const A = require('./adapters');

const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);

async function main() {
  const name = arg('adapter', 'oracle');
  const adapter = name === 'agent12' ? A.agent12({ provider: arg('provider', 'groq'), approve: arg('approve', 'every') }) : A[name];
  if (!adapter) throw new Error(`unknown adapter ${name}`);
  const tier = arg('tier', adapter.tier);
  const order = ['T1', 'T2', 'T3', 'T4'];
  let tasks = ALL.filter((t) => order.indexOf(t.tier) <= Math.max(order.indexOf(tier), 1));
  if (arg('only')) { const ids = arg('only').split(','); tasks = tasks.filter((t) => ids.includes(t.id)); }
  if (arg('category')) tasks = tasks.filter((t) => t.category === arg('category'));
  if (arg('limit')) tasks = tasks.slice(0, Number(arg('limit')));
  const bad = tasks.flatMap((t) => H.validateTask(t).map((p) => `${t.id}: ${p}`));
  if (bad.length) throw new Error(bad.join('\n'));
  const results = [];
  for (const t of tasks) {
    const r = await H.runTask(t, adapter, { corpus: byId });
    if (r.status === 'skipped') continue;
    results.push(r);
    console.log(`${r.passed && r.safe ? 'PASS' : r.safe ? 'FAIL' : 'UNSAFE'} ${r.id} (${r.steps} steps, ${r.interventions} interventions${r.escalations.length ? `, asked about ${r.escalations.join('/')}` : ''})${r.failed.length ? ` — ${r.failed[0]}` : ''}${r.status !== 'done' && r.notes ? ` [${r.status}: ${r.notes.slice(0, 160)}]` : ''}`);
  }
  const s = H.summarize(results, { adapter: adapter.name, tier });
  const md = H.report(s, results);
  const out = arg('out');
  if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, md); console.log(`wrote ${out}`); }
  console.log(`\n${s.adapter} [${tier}]: success ${s.success}% of ${s.n}, violations ${s.violations}, injection-unsafe ${s.injectionUnsafe}, escalation recall ${s.escalationRecall ?? 'n/a'}%, routine asked ${s.falseEscalationRate}%, interventions median ${s.medianInterventions}/p90 ${s.p90Interventions}. Level 5: ${s.level5 ? 'met' : 'not met'}.`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });

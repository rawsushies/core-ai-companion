#!/usr/bin/env node
'use strict';

// Injection corpus v1: how much the advisory detector (guard.scan) flags. Enforcement
// (whether the requested action is refused or escalated) is measured by the autonomy
// evaluation's injected tasks and, from P1, by the policy engine tests.
//   node eval/security/run.js [--out eval/results/security-detection.md]

const fs = require('fs');
const GUARD = require('../../src/main/guard');
const { CASES } = require('./injections');

const rows = CASES.map((c) => ({ ...c, flags: GUARD.scan(c.text) }));
const hit = rows.filter((r) => r.flags.length);
const by = (k) => Object.entries(rows.reduce((m, r) => { const g = (m[r[k]] = m[r[k]] || { n: 0, hit: 0 }); g.n++; if (r.flags.length) g.hit++; return m; }, {}));
const pct = (a, b) => `${Math.round((a / b) * 100)}%`;
const md = [
  '# Injection corpus v1: detection by the advisory guard',
  '',
  `Generated ${new Date().toISOString()} by \`node eval/security/run.js\`. ${CASES.length} cases written for 13.0 and never used to tune \`src/main/guard.js\`.`,
  'Detection is advisory: retrieved text is always fenced as data. What protects the user is enforcement (policy and taint, P1), measured separately.',
  '',
  `**Flagged: ${hit.length}/${rows.length} (${pct(hit.length, rows.length)}).**`,
  '',
  '| By carrier | Flagged |', '|---|---|', ...by('carrier').map(([k, g]) => `| ${k} | ${g.hit}/${g.n} |`),
  '',
  '| By attack | Flagged |', '|---|---|', ...by('attack').map(([k, g]) => `| ${k} | ${g.hit}/${g.n} |`),
  '',
  '<details><summary>Missed</summary>', '', ...rows.filter((r) => !r.flags.length).map((r) => `- ${r.id} (${r.carrier}, ${r.attack})`), '', '</details>', '',
].join('\n');
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : '';
if (out) fs.writeFileSync(out, md);
console.log(`guard flagged ${hit.length}/${rows.length}`);

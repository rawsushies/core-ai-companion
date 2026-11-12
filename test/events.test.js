'use strict';

// Proactive intelligence (Phase 3): permissioned event monitoring. Real file
// system events, the real memory gateway with the REAL Cortex server (when a
// checkout is available), a real workflow that changes files, and a verified
// outcome read back from disk.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventMonitor, globRe, ruleMatches } = require('../src/main/events');
const { Memory } = require('../src/main/memory');
const { CortexClient } = require('../src/main/cortex');
const { MemoryGateway } = require('../src/main/memgate');

const CORTEX_DIR = process.env.CORTEX_DIR || path.join(__dirname, '..', '..', 'rawsushies', 'cortex-ai-brain');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const pyOk = spawnSync(PY, ['--version'], { encoding: 'utf8' }).status === 0;
const cortexSkip = !fs.existsSync(path.join(CORTEX_DIR, 'run.py')) ? 'Cortex checkout not found (set CORTEX_DIR)' : !pyOk ? 'Python not available' : false;
const clients = [];
test.after(() => { for (const c of clients) c.dispose(); });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function harness(over = {}) {
  const log = [], reports = [], hist = new Map(), asked = [];
  const deps = {
    getRules: () => over.rules || [],
    permitted: (s) => (over.allow || ['files', 'windows']).includes(s),
    roots: () => over.roots || [],
    listTitles: over.listTitles,
    context: over.context || (async () => ''),
    history: (id) => hist.get(id) || [],
    record: (id, o) => hist.set(id, [...(hist.get(id) || []), o]),
    ask: async (rule, ev, ctx) => { asked.push({ rule, ev, ctx }); return over.approve !== false; },
    runWorkflow: over.runWorkflow || (async () => ({ status: 'done', summary: 'ok', verified: true })),
    report: (t, o) => reports.push({ t, o }),
    log: (e) => log.push(e),
    debounceMs: 300, pollMs: 200,
    ...(over.deps || {}),
  };
  return { mon: new EventMonitor(deps), log, reports, hist, asked };
}

test('globs and rule matching', () => {
  assert.ok(globRe('*.csv').test('a.csv'));
  assert.ok(!globRe('*.csv').test('dir/a.csv'));
  assert.ok(globRe('invoices/**/*.pdf').test('invoices/2026/x.pdf'));
  const r = { id: 'r', source: 'files', match: '*.csv' };
  assert.ok(ruleMatches(r, { source: 'files', rel: 'in/a.csv', kind: 'created' }), 'basename match');
  assert.ok(!ruleMatches({ ...r, enabled: false }, { source: 'files', rel: 'a.csv' }));
  assert.ok(!ruleMatches({ ...r, on: 'changed' }, { source: 'files', rel: 'a.csv', kind: 'created' }));
});

test('a source the user has not allowed never fires, even with a matching rule', async () => {
  const h = harness({ allow: [], rules: [{ id: 'r', name: 'R', source: 'files', match: '*', workflow: 'x', mode: 'auto' }] });
  assert.strictEqual(h.mon.emit({ source: 'files', rel: 'a.txt', kind: 'created' }), null);
  assert.strictEqual(h.reports.length, 0);
});

test('ask mode: declined runs nothing; cooldown and hourly budget bound proactive work', async () => {
  let runs = 0;
  const rule = { id: 'r', name: 'R', source: 'windows', match: '*Error*', workflow: 'x', cooldownMin: 10 };
  const h = harness({ approve: false, rules: [rule], runWorkflow: async () => { runs++; return { status: 'done', verified: true }; } });
  assert.strictEqual((await h.mon.emit({ source: 'windows', title: 'Build Error' })).status, 'declined');
  assert.strictEqual(runs, 0);
  assert.strictEqual((await h.mon.emit({ source: 'windows', title: 'Build Error 2' })).status, 'skipped', 'cooldown');
  const h2 = harness({ rules: [{ ...rule, mode: 'auto', cooldownMin: 0 }], deps: { maxPerHour: 2 } });
  await h2.mon.emit({ source: 'windows', title: 'Error 1' });
  await h2.mon.emit({ source: 'windows', title: 'Error 2' });
  assert.strictEqual((await h2.mon.emit({ source: 'windows', title: 'Error 3' })).reason, 'hourly budget');
});

test('window source: new titles after the baseline are events', async () => {
  let titles = ['Inbox'];
  const seen = [];
  const h = harness({ rules: [{ id: 'w', name: 'W', source: 'windows', match: '*failed*', workflow: 'x', mode: 'auto' }], listTitles: async () => titles, runWorkflow: async (r, ev) => { seen.push(ev.title); return { status: 'done', verified: true }; } });
  h.mon.start();
  try {
    await wait(500);
    titles = ['Inbox', 'Deploy failed - Console', 'Music'];
    for (let i = 0; i < 20 && !seen.length; i++) await wait(150);
    assert.deepStrictEqual(seen, ['Deploy failed - Console']);
  } finally { h.mon.stop(); }
});

test('PHASE 3 ACCEPTANCE: real file event -> relevance -> history + Cortex -> authorized workflow -> verified report', { skip: cortexSkip, timeout: 90000 }, async () => {
  const inbox = tmp('core-inbox-'), dataDir = tmp('core-mem-');
  const memory = new Memory(path.join(dataDir, 'memory.json'));
  const cortex = new CortexClient({ cfg: { command: PY, args: [path.join(CORTEX_DIR, 'run.py'), 'mcp'], vault: tmp('core-vault-'), env: { CORTEX_LOCAL_DIR: path.join(dataDir, 'cl') } }, timeoutMs: 20000 });
  clients.push(cortex);
  const gate = new MemoryGateway({ memory, cortex, queueFile: path.join(dataDir, 'q.json'), recallTimeoutMs: 15000 });
  assert.strictEqual((await gate.remember('Invoice totals over 10000 must be flagged for review', { kind: 'decision', project: 'Invoices' })).stored, 'cortex');

  // The workflow: total the invoice CSV and write a summary next to it. The
  // outcome is verified by reading the summary back, not by the workflow's word.
  const workflow = async (rule, ev, ctx) => {
    const rows = fs.readFileSync(ev.path, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => Number(l.split(',')[1]) || 0);
    const total = rows.reduce((a, b) => a + b, 0);
    const flag = /over 10000 must be flagged/.test(ctx.text) && total > 10000;
    const out = path.join(path.dirname(ev.path), `${path.basename(ev.path, '.csv')}.summary.txt`);
    fs.writeFileSync(out, `total=${total}${flag ? ' FLAG: review required' : ''}`);
    const verified = fs.readFileSync(out, 'utf8').startsWith(`total=${total}`);
    return { status: 'done', summary: `total ${total}${flag ? ', flagged for review' : ''} -> ${path.basename(out)}`, verified };
  };
  const rule = { id: 'inv', name: 'Invoice intake', source: 'files', match: '*.csv', on: 'created', workflow: 'invoice-summary', mode: 'auto', cooldownMin: 0 };
  const h = harness({ rules: [rule], roots: [inbox], context: async (q) => (await gate.context(q)).text, runWorkflow: workflow });
  // An earlier run of this rule is part of the history the next run sees.
  h.hist.set('inv', [{ at: Date.now() - 86400000, status: 'done', summary: 'total 800 -> march.summary.txt', verified: true }]);
  let ctxSeen = null;
  const run = workflow;
  h.mon.d.runWorkflow = async (r, ev, ctx) => { ctxSeen = ctx; return run(r, ev, ctx); };
  h.mon.start();
  try {
    await wait(300);
    fs.writeFileSync(path.join(inbox, 'notes.txt'), 'not an invoice'); // irrelevant event
    fs.writeFileSync(path.join(inbox, 'april.csv'), 'item,amount\nsteel,9000\nglass,4200\n');
    for (let i = 0; i < 60 && !h.reports.length; i++) await wait(200);
    assert.strictEqual(h.reports.length, 1, `exactly the relevant event ran: ${JSON.stringify(h.log)}`);
    assert.match(h.reports[0].t, /^Invoice intake: File created: april\.csv\. Done \(verified\): total 13200, flagged for review/);
    assert.strictEqual(fs.readFileSync(path.join(inbox, 'april.summary.txt'), 'utf8'), 'total=13200 FLAG: review required');
    assert.match(ctxSeen.text, /Earlier runs of "Invoice intake"\] \(history, may be outdated\)/);
    assert.match(ctxSeen.text, /total 800/);
    assert.match(ctxSeen.text, /Projects\/Invoices\.md/, 'Cortex knowledge recalled with its source');
    assert.strictEqual(h.hist.get('inv').length, 2, 'the verified outcome is recorded for next time');
    assert.ok(h.log.some((e) => e.event === 'monitor-outcome' && e.verified));
  } finally { h.mon.stop(); }
});

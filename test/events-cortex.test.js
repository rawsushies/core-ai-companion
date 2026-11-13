'use strict';
// Automations triggered by Cortex's own events (a note changed, a task due).
// Unit tests always run; the live test needs a Cortex 2 checkout (CORTEX_DIR) and Python.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventMonitor, cortexEvents, ruleMatches } = require('../src/main/events');
const { CortexClient } = require('../src/main/cortex');

const CORTEX_DIR = process.env.CORTEX_DIR || path.join(__dirname, '..', '..', 'rawsushies', 'cortex-ai-brain');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const pyOk = spawnSync(PY, ['--version']).status === 0;
const has2 = fs.existsSync(path.join(CORTEX_DIR, 'cortex_gateway', '__init__.py'));
const skip = !fs.existsSync(path.join(CORTEX_DIR, 'run.py')) ? 'Cortex checkout not found (set CORTEX_DIR)' : !pyOk ? 'Python not available' : !has2 ? 'needs Cortex 2.0+' : false;

function monitor(rules, { permitted = true } = {}) {
  const ran = [];
  const m = new EventMonitor({
    getRules: () => rules, permitted: (s) => s === 'cortex' && permitted, context: async () => '', history: () => [], record: () => {},
    ask: async () => true, runWorkflow: async (rule, ev) => { ran.push([rule.id, ev.kind, ev.rel || ev.title]); return { status: 'done', verified: true }; },
    report: () => {}, log: () => {},
  });
  return { m, ran };
}

test('notifications become events; at most 20 per notification', () => {
  const evs = cortexEvents('changed', { paths: Array.from({ length: 30 }, (_, i) => `N${i}.md`), actor: 'outside', outside: true });
  assert.strictEqual(evs.length, 20);
  assert.deepStrictEqual(evs[0], { source: 'cortex', kind: 'changed', rel: 'N0.md', actor: 'outside', outside: true });
  const due = cortexEvents('task_due', { tasks: [{ text: 'Pay rent 📅 2026-11-13', due: '2026-11-13', path: 'Daily/x.md' }] });
  assert.deepStrictEqual(due[0], { source: 'cortex', kind: 'task_due', rel: 'Daily/x.md', title: 'Pay rent', due: '2026-11-13' });
  assert.deepStrictEqual(cortexEvents('something_else', {}), []);
});

test('rules match by kind and by note path or task text', () => {
  const ch = { source: 'cortex', kind: 'changed', rel: 'Projects/Cabin.md' };
  assert.ok(ruleMatches({ source: 'cortex', match: 'Projects/*', on: 'changed' }, ch));
  assert.ok(ruleMatches({ source: 'cortex', match: 'Cabin.md' }, ch));
  assert.ok(!ruleMatches({ source: 'cortex', match: 'Projects/*', on: 'task_due' }, ch));
  assert.ok(ruleMatches({ source: 'cortex', match: 'Pay*', on: 'task_due' }, { source: 'cortex', kind: 'task_due', rel: 'Daily/x.md', title: 'Pay rent' }));
});

test('the user switch, cooldown and one-at-a-time still apply', async () => {
  const off = monitor([{ id: 'r', name: 'r', source: 'cortex', match: '*', workflow: 'w', mode: 'auto' }], { permitted: false });
  assert.deepStrictEqual(off.m.cortex('changed', { paths: ['A.md'] }), []);
  const on = monitor([{ id: 'r', name: 'r', source: 'cortex', match: 'Projects/*', workflow: 'w', mode: 'auto' }]);
  await Promise.all(on.m.cortex('changed', { paths: ['Projects/A.md', 'Projects/B.md', 'Other.md'] }));
  assert.deepStrictEqual(on.ran, [['r', 'changed', 'Projects/A.md']]); // B: cooldown; Other: no match
});

test('live: an edit made in Obsidian starts the matching automation', { skip, timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-evc-'));
  const vault = path.join(dir, 'vault');
  const { m, ran } = monitor([{ id: 'proj', name: 'Project changed', source: 'cortex', match: 'Projects/*', on: 'changed', workflow: 'w', mode: 'auto' }]);
  const cortex = new CortexClient({ cfg: { command: PY, args: [path.join(CORTEX_DIR, 'run.py'), 'mcp'], vault, env: { CORTEX_LOCAL_DIR: path.join(dir, 'cl'), CORTEX_EVENT_INTERVAL: '0.3' } }, timeoutMs: 60000, onEvent: (n, p) => m.cortex(n, p) });
  try {
    await cortex.call('brain_write', { path: 'Projects/Cabin.md', content: '# Cabin', mode: 'create' }); // COre's own write: no event
    await new Promise((r) => setTimeout(r, 600));
    assert.deepStrictEqual(ran, []);
    fs.writeFileSync(path.join(vault, 'Projects', 'Cabin.md'), '# Cabin\nedited in Obsidian');
    for (let i = 0; i < 50 && !ran.length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepStrictEqual(ran, [['proj', 'changed', 'Projects/Cabin.md']]);
  } finally { cortex.dispose(); }
});

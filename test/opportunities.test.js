'use strict';

// Opportunity detection (Phase 3 #4): real Cortex to-dos, an interrupted
// desktop task, automation history and the Cortex queue become a few sourced
// suggestions. Nothing is executed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Opportunities, parseTasks } = require('../src/main/opportunities');
const { CortexClient } = require('../src/main/cortex');

const CORTEX_DIR = process.env.CORTEX_DIR || path.join(__dirname, '..', '..', 'rawsushies', 'cortex-ai-brain');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const pyOk = spawnSync(PY, ['--version'], { encoding: 'utf8' }).status === 0;
const skip = !fs.existsSync(path.join(CORTEX_DIR, 'run.py')) ? 'Cortex checkout not found (set CORTEX_DIR)' : !pyOk ? 'Python not available' : false;
const clients = [];
test.after(() => { for (const c of clients) c.dispose(); });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('Cortex task lines parse', () => {
  const t = parseTasks('- [ ] Send the facade drawings (due 2026-01-02, OVERDUE) — Projects/Tower.md\n- [ ] Call Budi — Daily/2026-01-01.md\nNo tasks.');
  assert.deepStrictEqual(t, [
    { text: 'Send the facade drawings', due: '2026-01-02', overdue: true, path: 'Projects/Tower.md' },
    { text: 'Call Budi', due: '', overdue: false, path: 'Daily/2026-01-01.md' },
  ]);
});

test('suggestions are bounded, ranked, sourced and dismissable; nothing runs', async () => {
  const now = Date.now();
  const o = new Opportunities({
    agentTask: () => ({ status: 'running', goal: 'rename the photos', step: 4, at: now - 3600e3, taskId: 't1' }),
    automationHistory: () => ({ invoices: [{ at: now - 3600e3, status: 'failed', what: 'File created: may.csv', summary: 'no playbook' }], notes: [{ at: now - 60e3, status: 'done', verified: false, what: 'File created: a.txt' }] }),
    pending: () => 2,
    max: 3,
  });
  const list = await o.find();
  assert.strictEqual(list.length, 3, 'at most 3');
  assert.deepStrictEqual(list.map((s) => s.source), ['agent', 'automation', 'memory']);
  assert.strictEqual(list[0].action, '/do resume');
  o.dismiss(list[0].id);
  assert.ok(!(await o.find()).some((s) => s.source === 'agent'), 'dismissed stays dismissed');
  assert.match(Opportunities.format(list), /nothing has been done/);
});

test('real Cortex: overdue and due-today to-dos become suggestions with their note', { skip, timeout: 60000 }, async () => {
  const dir = tmp('core-opp-');
  const cortex = new CortexClient({ cfg: { command: PY, args: [path.join(CORTEX_DIR, 'run.py'), 'mcp'], vault: path.join(dir, 'vault'), env: { CORTEX_LOCAL_DIR: path.join(dir, 'cl') } }, timeoutMs: 60000 });
  clients.push(cortex);
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  await cortex.call('brain_write', { path: 'Projects/Tower.md', content: '# Tower\n\n## Tasks\n', mode: 'create' });
  await cortex.call('brain_tasks', { action: 'add', text: 'Send the facade drawings to the client', path: 'Projects/Tower.md', due: day(-2) });
  await cortex.call('brain_tasks', { action: 'add', text: 'Approve the lobby samples', path: 'Projects/Tower.md', due: day(0) });
  await cortex.call('brain_tasks', { action: 'add', text: 'Plan the topping-out party', path: 'Projects/Tower.md', due: day(30) });
  const o = new Opportunities({ cortex, max: 5 });
  const list = await o.find();
  const texts = list.map((s) => s.text).join('\n');
  assert.match(texts, /Overdue since .*"Send the facade drawings to the client" \(Projects\/Tower\.md\)/, texts);
  assert.match(texts, /Due today: "Approve the lobby samples"/);
  assert.doesNotMatch(texts, /topping-out/, 'not-yet-due tasks are not pushed');
  assert.ok(list.every((s) => s.source === 'cortex'));
  // Reading suggestions changed nothing in the vault.
  assert.match(String(await cortex.call('brain_tasks', { action: 'list', status: 'open' })), /Send the facade drawings/);
});

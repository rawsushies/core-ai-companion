'use strict';
// Cortex results as data: tasks for suggestions, project context for the situation.
// Unit tests use fakes; live tests need a Cortex 2 checkout (CORTEX_DIR) and Python.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { openTasks } = require('../src/main/opportunities');
const { Situation } = require('../src/main/situation');
const { CortexClient } = require('../src/main/cortex');
const { MemoryGateway } = require('../src/main/memgate');

const CORTEX_DIR = process.env.CORTEX_DIR || path.join(__dirname, '..', '..', 'rawsushies', 'cortex-ai-brain');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const pyOk = spawnSync(PY, ['--version']).status === 0;
const has2 = fs.existsSync(path.join(CORTEX_DIR, 'cortex_gateway', '__init__.py'));
const skip = !fs.existsSync(path.join(CORTEX_DIR, 'run.py')) ? 'Cortex checkout not found (set CORTEX_DIR)' : !pyOk ? 'Python not available' : !has2 ? 'needs Cortex 2.0+' : false;
const clients = [];
test.after(() => { for (const c of clients) c.dispose(); });

test('tasks: structured data when Cortex has it, the text lines otherwise', async () => {
  const structured = { callData: async () => ({ text: 'ignored', data: { tasks: [{ text: 'Pay A — B invoice 📅 2026-01-01', due: '2026-01-01', overdue: true, done: false, path: 'Daily/x.md' }] } }) };
  assert.deepStrictEqual(await openTasks(structured), [{ text: 'Pay A — B invoice', due: '2026-01-01', overdue: true, path: 'Daily/x.md' }]);
  const textOnly = { callData: async () => ({ text: '- [ ] Ship it (due 2026-02-02) — Projects/X.md', data: null }) };
  assert.strictEqual((await openTasks(textOnly))[0].path, 'Projects/X.md');
  const veryOld = { call: async () => '- [ ] Old style — Inbox.md' };
  assert.strictEqual((await openTasks(veryOld))[0].text, 'Old style');
});

test('situation: the project on screen brings its decisions and open tasks', async () => {
  const uia = { snapshot: async () => ({ active: { name: 'Cabin plan.pln - Archicad', process: 'Archicad' }, windows: [{ name: 'Cabin plan.pln - Archicad' }], dialogs: [], controls: [] }) };
  const gateway = {
    context: async () => ({ text: '', sources: [{ system: 'cortex', path: 'Projects/Cabin.md' }], cortex: 'ok' }),
    projectContext: async (name) => ({ path: `Projects/${name}.md`, decisions: [{ text: '2026-11-01 We chose a timber frame', verified: true }, { text: '2026-11-02 Paint it red', verified: false }], tasks: [{ text: 'Order windows 📅 2026-12-01', due: '2026-12-01', overdue: false, path: 'Projects/Cabin.md' }] }),
  };
  const s = new Situation({ uia, gateway });
  s.observe = async () => ({ at: Date.now(), active: { name: 'Cabin plan.pln - Archicad', process: 'Archicad' }, windows: [{ name: 'Cabin plan.pln - Archicad' }], dialogs: [], controls: [], changes: [] });
  const d = await s.describe();
  const texts = d.facts.map((f) => f.text);
  assert.ok(texts.includes('Decision in Cabin: 2026-11-01 We chose a timber frame'), texts.join('\n'));
  assert.ok(texts.includes('Decision in Cabin: 2026-11-02 Paint it red (unverified)'));
  assert.ok(texts.includes('Open task in Cabin: Order windows (due 2026-12-01)'));
});

test('live: a task with " — " in its text keeps its due date and path', { skip, timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-st-'));
  const cortex = new CortexClient({ cfg: { command: PY, args: [path.join(CORTEX_DIR, 'run.py'), 'mcp'], vault: path.join(dir, 'v'), env: { CORTEX_LOCAL_DIR: path.join(dir, 'cl') } }, timeoutMs: 60000 });
  clients.push(cortex);
  await cortex.call('brain_tasks', { action: 'add', text: 'Read A — B chapter', due: '2020-01-01', path: 'Projects/Books.md' });
  const [t] = await openTasks(cortex);
  assert.deepStrictEqual(t, { text: 'Read A — B chapter', due: '2020-01-01', overdue: true, path: 'Projects/Books.md' });
  const gate = new MemoryGateway({ memory: null, cortex, recallTimeoutMs: 30000 });
  await gate.remember('We decided to read one chapter a week', { kind: 'decision', project: 'Books' });
  const pc = await gate.projectContext('Books');
  assert.strictEqual(pc.path, 'Projects/Books.md');
  assert.ok(pc.decisions.some((d) => /one chapter a week/.test(d.text)));
  assert.strictEqual(pc.tasks[0].text.split(' 📅')[0], 'Read A — B chapter');
});

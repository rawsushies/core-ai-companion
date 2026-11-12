'use strict';

// PHASE 2 ACCEPTANCE on real Windows: COre reads the real desktop through UI
// Automation (a project window plus an open dialog), identifies the project,
// recalls context from BOTH memory systems (COre memory + the real Cortex MCP
// server), and every fact it would explain carries its source. An answer that
// invents a window is caught by the grounding check.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { UiaClient } = require('../src/main/uia');
const { Memory } = require('../src/main/memory');
const { CortexClient } = require('../src/main/cortex');
const { MemoryGateway } = require('../src/main/memgate');
const { Situation, groundCheck } = require('../src/main/situation');

const win = process.platform === 'win32';
const CORTEX_DIR = process.env.CORTEX_DIR || path.join(__dirname, '..', '..', 'rawsushies', 'cortex-ai-brain');
const pyOk = win && spawnSync('python', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = !win ? 'Windows only' : !fs.existsSync(path.join(CORTEX_DIR, 'run.py')) ? 'Cortex checkout not found' : !pyOk ? 'Python not available' : false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const FORM = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Lakeside Budget.xlsx - Planner'; $f.Width = 420; $f.Height = 220; $f.StartPosition = 'CenterScreen'
$t = New-Object System.Windows.Forms.TextBox; $t.Left = 20; $t.Top = 20; $t.Width = 200; $t.Text = 'Facade 4.2M'
$f.Controls.Add($t)
$f.Add_Shown({ $f.Activate() })
$tm = New-Object System.Windows.Forms.Timer; $tm.Interval = 1500
$tm.Add_Tick({ $tm.Stop(); [void][System.Windows.Forms.MessageBox]::Show($f, 'Save changes to Lakeside Budget?', 'Planner', 'YesNo') })
$tm.Start()
[System.Windows.Forms.Application]::Run($f)
`;

test('PHASE 2 ACCEPTANCE: real desktop + project + both memory systems, sourced, no fabrication', { skip, timeout: 180000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-sit-'));
  const file = path.join(dir, 'form.ps1');
  fs.writeFileSync(file, FORM);
  const memory = new Memory(path.join(dir, 'memory.json'));
  const cortex = new CortexClient({ cfg: { command: 'python', args: [path.join(CORTEX_DIR, 'run.py'), 'mcp'], vault: path.join(dir, 'vault'), env: { CORTEX_LOCAL_DIR: path.join(dir, 'cl') } }, timeoutMs: 30000 });
  const gate = new MemoryGateway({ memory, cortex, queueFile: path.join(dir, 'q.json'), recallTimeoutMs: 20000 });
  const uia = new UiaClient({ timeoutMs: 30000 });
  const app = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-STA', '-File', file], { stdio: 'ignore' });
  try {
    memory.remember('#Lakeside the facade budget is reviewed every Friday', { kind: 'project' });
    assert.strictEqual((await gate.remember('The client capped the Lakeside facade at 4.2M', { kind: 'decision', project: 'Lakeside' })).stored, 'cortex');

    // Wait until the project window and its dialog are both on the real desktop.
    let ws = [];
    for (let i = 0; i < 60; i++) {
      await wait(500);
      ws = await uia.windows({ owned: true });
      if (ws.some((w) => w.name === 'Lakeside Budget.xlsx - Planner') && ws.some((w) => w.name === 'Planner')) break;
    }
    console.log('windows:', JSON.stringify(ws.map((w) => ({ name: w.name, cls: w.cls, fg: w.foreground, state: w.state, modal: w.modal, dialog: w.dialog }))));

    const sit = new Situation({ uia, gateway: gate, memory });
    await sit.describe('warm up'); // first call starts PowerShell and Cortex
    // Responsiveness budgets on real Windows (warm): measured and logged every run.
    const timed = async (f) => { const t = Date.now(); await f(); return Date.now() - t; };
    const perf = {
      windows: await timed(() => uia.windows()),
      windowsWithDialogs: await timed(() => uia.windows({ owned: true })),
      snapshot: await (async () => { const fresh = await uia.windows(); const id = fresh.find((x) => x.name === 'Lakeside Budget.xlsx - Planner').id; return timed(() => uia.snapshot({ target: id })); })(), // ids are valid until the next listing
    };
    let d = null;
    perf.situation = await timed(async () => { d = await sit.describe('what am I working on?'); });
    console.log('perf (ms):', JSON.stringify(perf));
    assert.ok(perf.windows < 3000 && perf.snapshot < 3000, `UI Automation reads stay interactive: ${JSON.stringify(perf)}`);
    assert.ok(perf.situation < 8000, `a full situation (desktop + both memories) in under 8 s: ${perf.situation} ms`);
    console.log('facts:', JSON.stringify(d.facts));
    const text = d.facts.map((f) => `[${f.source}] ${f.text}`).join('\n');

    assert.match(text, /\[observed\] .*"Lakeside Budget\.xlsx - Planner"/, 'the real project window is observed');
    assert.ok(d.obs.dialogs.some((x) => x.name === 'Planner'), 'the real message box is recognised as a dialog');
    assert.match(text, /\[inferred\] Project in view: Lakeside/);
    assert.ok(d.facts.some((f) => f.source === 'cortex' && f.ref === 'Projects/Lakeside.md'), 'Cortex note recalled with its path');
    assert.ok(d.facts.some((f) => f.source === 'memory'), 'COre active memory recalled');
    assert.match(d.memory.text, /4\.2M/);
    assert.match(d.memory.text, /every Friday/);
    assert.match(d.prompt, /do not mention any window, file, project or decision that is not listed/);

    assert.ok(groundCheck('You are in Lakeside Budget.xlsx in Planner, a save dialog is open, and Projects/Lakeside.md says the facade is capped at 4.2M.', d.facts, d.memory.text).ok);
    const bad = groundCheck('You also have "Tower Render.png" open.', d.facts, d.memory.text);
    assert.ok(!bad.ok && bad.unsupported.includes('Tower Render.png'));
  } finally {
    uia.dispose();
    cortex.dispose();
    try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
});

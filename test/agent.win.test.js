'use strict';

// Phase 1 acceptance on real Windows: the desktop agent operates a real Win32
// app through real UI Automation, is interrupted, resumes from its checkpoint,
// and the outcome is verified from the app itself. The reasoning is scripted
// (CI has no AI provider), everything else is the production code path.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const AG = require('../src/main/agent');
const { UiaClient } = require('../src/main/uia');

const win = process.platform === 'win32';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FORM = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'COre Agent Test'; $f.Width = 420; $f.Height = 220; $f.StartPosition = 'CenterScreen'
$t = New-Object System.Windows.Forms.TextBox; $t.Left = 20; $t.Top = 20; $t.Width = 200
$b = New-Object System.Windows.Forms.Button; $b.Text = 'Greet'; $b.Left = 240; $b.Top = 18
$c = New-Object System.Windows.Forms.CheckBox; $c.Text = 'Remember me'; $c.Left = 20; $c.Top = 60; $c.Width = 200
$l = New-Object System.Windows.Forms.Label; $l.Text = 'waiting'; $l.Left = 20; $l.Top = 100; $l.Width = 300
$b.Add_Click({ $l.Text = 'Hello, ' + $t.Text })
$f.Controls.AddRange(@($t, $b, $c, $l))
[System.Windows.Forms.Application]::Run($f)
`;

// A scripted brain: reads the control list COre puts in the prompt and picks the next action.
function brain(steps) {
  return async ({ text }) => {
    if (/\[agent-plan\]/.test(text)) return '1. Type Ada in the name box\n2. Press Greet\n3. Tick Remember me\nDone when: the label says Hello, Ada and Remember me is checked';
    const id = (re) => { const m = new RegExp(`\\[(\\d+)\\] ${re}`).exec(text); return m ? Number(m[1]) : -1; };
    const next = steps.shift();
    if (!next) return '[[act {"type":"done","summary":"greeted Ada and ticked Remember me"}]]';
    if (next === 'fill') return `[[act {"type":"fill","el":${id('Edit')},"text":"Ada"}]]`;
    if (next === 'greet') return `[[act {"type":"press","el":${id('Button "Greet"')}}]]`;
    if (next === 'check') return `[[act {"type":"press","el":${id('CheckBox "Remember me"')}}]]`;
    return '[[act {"type":"wait","ms":300}]]';
  };
}

test('agent completes a multi-step task on a real Win32 app, survives an interruption, resumes, and the result is verified', { skip: !win, timeout: 180000 }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'core-agent-')), 'form.ps1');
  fs.writeFileSync(file, FORM);
  const app = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-STA', '-File', file], { stdio: 'ignore' });
  const uia = new UiaClient({ timeoutMs: 30000 });
  try {
    let w = null;
    for (let i = 0; i < 60 && !w; i++) { await wait(500); w = (await uia.windows()).find((x) => x.name === 'COre Agent Test'); }
    assert.ok(w, 'app window found');
    // The agent works on this window's controls.
    const scoped = { ...uia, snapshot: () => uia.snapshot({ target: w.id }), invoke: (e) => uia.invoke(e), setValue: (e, t) => uia.setValue(e, t), value: (e) => uia.value(e), focus: (e) => uia.focus(e), expand: (e) => uia.expand(e) };
    const shot = async () => ({ width: 800, height: 600, displayWidth: 800, displayHeight: 600, scaleFactor: 1, windows: ['COre Agent Test'] });
    let saved = null;
    const common = { screenshot: shot, driver: { perform: async () => {} }, approve: async () => 'yes', openApp: async () => {}, onStep: () => {}, settleMs: 200, uia: scoped, autoApprove: true, verify: false, checkpoint: (st) => { saved = JSON.parse(JSON.stringify(st)); } };

    // Run 1: fill and greet, then the user interrupts.
    const steps1 = ['fill', 'greet', 'wait', 'wait', 'wait'];
    const r1 = new AG.AgentRunner({ ...common, think: brain(steps1) });
    const p1 = r1.run('greet Ada and remember me');
    for (let i = 0; i < 120 && !(saved && saved.history.length >= 2); i++) await wait(250);
    r1.stop('you pressed Esc');
    const out1 = await p1;
    assert.strictEqual(out1.status, 'stopped');
    assert.ok(saved.plan && saved.plan.steps.length === 3, 'the plan was checkpointed');
    assert.ok(saved.history.slice(0, 2).every((h) => h.ok), JSON.stringify(saved.history));

    // Run 2: resume from the checkpoint and finish.
    const r2 = new AG.AgentRunner({ ...common, think: brain(['check']) });
    const out2 = await r2.run('greet Ada and remember me', { resume: saved });
    assert.strictEqual(out2.status, 'done', JSON.stringify(out2));

    // Verify the real outcome from the app, not from the agent's claim.
    const snap = await uia.snapshot({ target: w.id });
    const label = snap.elements.find((e) => e.type === 'Text' && /^Hello, /.test(e.name || ''));
    assert.ok(label && label.name === 'Hello, Ada', `label: ${label && label.name}`);
    assert.strictEqual(snap.elements.find((e) => e.type === 'CheckBox').toggle, 'On');
  } finally {
    uia.dispose();
    try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
});

// PHASE 4 ACCEPTANCE on real Windows: one task that uses knowledge from the
// real Cortex, runs commands in the real AppContainer sandbox (one of them an
// unauthorized read that must fail, and the agent recovers), operates a real
// Win32 app through UI Automation, and is verified from the app and the disk;
// the verified outcome is then filed back into Cortex.
const { spawnSync } = require('child_process');
const SBX = require('../src/main/sandbox');
const AT = require('../src/main/agentTools');
const { Memory } = require('../src/main/memory');
const { CortexClient } = require('../src/main/cortex');
const { MemoryGateway } = require('../src/main/memgate');
const CORTEX_DIR = process.env.CORTEX_DIR || path.join(__dirname, '..', '..', 'rawsushies', 'cortex-ai-brain');
const p4skip = !win ? 'Windows only' : !fs.existsSync(path.join(CORTEX_DIR, 'run.py')) ? 'Cortex checkout not found' : spawnSync('python', ['--version']).status !== 0 ? 'Python not available' : false;

test('PHASE 4 ACCEPTANCE (Windows): Cortex knowledge + sandboxed commands with a refused read + real app via UIA, verified and remembered', { skip: p4skip, timeout: 240000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-p4-'));
  const project = path.join(dir, 'project'); fs.mkdirSync(project);
  const homeSecret = path.join(os.homedir(), `core-p4-secret-${process.pid}.txt`); fs.writeFileSync(homeSecret, 'home-secret-value');
  fs.writeFileSync(path.join(project, 'probe.js'), `try{console.log('READ', require('fs').readFileSync(${JSON.stringify(homeSecret)},'utf8'))}catch(e){console.log('DENIED', e.code); process.exit(5)}`);
  fs.writeFileSync(path.join(project, 'save.js'), "require('fs').writeFileSync('client.txt', process.argv[2]); console.log('saved', process.argv[2])");
  const formFile = path.join(dir, 'form.ps1'); fs.writeFileSync(formFile, FORM);
  const memory = new Memory(path.join(dir, 'memory.json'));
  const cortex = new CortexClient({ cfg: { command: 'python', args: [path.join(CORTEX_DIR, 'run.py'), 'mcp'], vault: path.join(dir, 'vault'), env: { CORTEX_LOCAL_DIR: path.join(dir, 'cl') } }, timeoutMs: 60000 });
  const gate = new MemoryGateway({ memory, cortex, queueFile: path.join(dir, 'q.json'), recallTimeoutMs: 30000 });
  const app = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-STA', '-File', formFile], { stdio: 'ignore' });
  const uia = new UiaClient({ timeoutMs: 30000 });
  const commands = [];
  try {
    await cortex.call('brain_health', {});
    assert.strictEqual((await gate.remember('The client contact for the Greeter project is Ada', { kind: 'decision', project: 'Greeter' })).stored, 'cortex');
    let w = null;
    for (let i = 0; i < 60 && !w; i++) { await wait(500); w = (await uia.windows()).find((x) => x.name === 'COre Agent Test'); }
    assert.ok(w, 'app window found');
    const scoped = { snapshot: () => uia.snapshot({ target: w.id }), invoke: (e) => uia.invoke(e), setValue: (e, t) => uia.setValue(e, t), value: (e) => uia.value(e), focus: (e) => uia.focus(e), expand: (e) => uia.expand(e) };
    // The production command path: checkCommand -> sandbox (AppContainer + Job) -> runCommand.
    const tools = {
      mustAsk: () => false,
      run: async (a) => {
        const c = AT.checkCommand(a.cmd);
        if (!c.ok) throw new Error(`Command refused: ${c.reason}.`);
        const sw = SBX.wrap(c.argv, { cwd: project, roots: [project] });
        assert.strictEqual(sw.level, 'container');
        const r = await AT.runCommand([sw.file, ...sw.args], { cwd: project, timeoutMs: 60000 });
        commands.push({ cmd: a.cmd, code: r.code, out: r.out });
        if (r.code !== 0 && !r.out) throw new Error(`exit code ${r.code}`);
        return `exit code ${r.code} (sandboxed)\n${r.out}`;
      },
    };
    const experience = (await gate.context('Greeter project client contact')).text;
    assert.match(experience, /Ada/, 'Cortex knowledge reaches the agent');
    // Scripted reasoning (no provider in CI): reads the knowledge and the controls COre puts in the prompt.
    const think = async ({ text }) => {
      if (/\[agent-plan\]/.test(text)) return '1. Check for an existing contact file\n2. Save the client name\n3. Type it into the app and press Greet\nDone when: the label greets the client and client.txt holds the name';
      const name = (/client contact for the Greeter project is (\w+)/.exec(text) || [])[1] || 'UNKNOWN';
      const id = (re) => { const m = new RegExp(`\\[(\\d+)\\] ${re}`).exec(text); return m ? Number(m[1]) : -1; };
      const steps = (text.match(/^\d+\. /gm) || []).length;
      if (/reply done again/.test(text)) return '[[act {"type":"done","summary":"greeted the client and saved the name"}]]';
      if (!/Steps so far:\s*\n1\./.test(text)) return '[[act {"type":"run","cmd":"node probe.js","why":"look for an existing contact"}]]';
      if (/DENIED/.test(text) && !/saved /.test(text)) return `[[act {"type":"run","cmd":"node save.js ${name}","why":"save the client name"}]]`;
      if (!/Fill/.test(text)) return `[[act {"type":"fill","el":${id('Edit')},"text":"${name}"}]]`;
      if (!/Press/.test(text)) return `[[act {"type":"press","el":${id('Button "Greet"')}}]]`;
      void steps;
      return '[[act {"type":"done","summary":"greeted the client"}]]';
    };
    const r = await new AG.AgentRunner({
      think, tools, experience, uia: scoped, autoApprove: true, verify: true, settleMs: 300,
      screenshot: async () => ({ width: 800, height: 600, displayWidth: 800, displayHeight: 600, scaleFactor: 1, windows: ['COre Agent Test'] }),
      driver: { perform: async () => {} }, approve: async () => 'yes', openApp: async () => {}, onStep: () => {},
    }).run('greet the Greeter client and save their name');
    console.log('steps:', JSON.stringify(r.steps && r.steps.map((s) => [s.label, s.ok])), 'commands:', JSON.stringify(commands));
    assert.strictEqual(r.status, 'done', JSON.stringify(r));
    // The unauthorized read really ran in the sandbox and was refused; nothing leaked.
    assert.ok(commands[0] && /DENIED/.test(commands[0].out) && commands[0].code === 5, JSON.stringify(commands[0]));
    assert.ok(!commands.some((c) => /home-secret-value/.test(c.out)));
    // Verified from the disk and from the app, not from the agent's word.
    assert.strictEqual(fs.readFileSync(path.join(project, 'client.txt'), 'utf8'), 'Ada');
    const snap = await uia.snapshot({ target: w.id });
    assert.ok(snap.elements.some((e) => e.type === 'Text' && e.name === 'Hello, Ada'), 'the app greets Ada');
    // The verified outcome goes to long-term memory and comes back next time.
    assert.strictEqual((await gate.remember(`Verified on the desktop: ${r.summary} (task "greet the Greeter client")`, { kind: 'knowledge', project: 'Greeter' })).stored, 'cortex');
    assert.match((await gate.context('what was verified for the Greeter client')).text, /Verified on the desktop: greeted the client/);
  } finally {
    uia.dispose(); cortex.dispose();
    try { fs.unlinkSync(homeSecret); } catch {}
    try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
});

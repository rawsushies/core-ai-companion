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

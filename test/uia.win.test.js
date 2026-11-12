'use strict';

// Real Windows UI Automation against real applications. Runs only on Windows
// (the windows-latest CI job and Windows PCs); elsewhere it is skipped.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { UiaClient, outline } = require('../src/main/uia');

const win = process.platform === 'win32';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (p) => { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

// A real Win32 (WinForms) window with standard controls.
const FORM = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.Text = 'COre UIA Test'; $f.Width = 420; $f.Height = 220; $f.StartPosition = 'CenterScreen'
$t = New-Object System.Windows.Forms.TextBox; $t.Name = 'nameBox'; $t.AccessibleName = 'Your name'; $t.Left = 20; $t.Top = 20; $t.Width = 200
$b = New-Object System.Windows.Forms.Button; $b.Text = 'Greet'; $b.Left = 240; $b.Top = 18
$c = New-Object System.Windows.Forms.CheckBox; $c.Text = 'Remember me'; $c.Left = 20; $c.Top = 60; $c.Width = 200
$l = New-Object System.Windows.Forms.Label; $l.Name = 'result'; $l.Text = 'waiting'; $l.Left = 20; $l.Top = 100; $l.Width = 300
$b.Add_Click({ $l.Text = 'Hello, ' + $t.Text })
$f.Controls.AddRange(@($t, $b, $c, $l))
[System.Windows.Forms.Application]::Run($f)
`;

test('UI Automation reads and operates a real Win32 app: fill, press, toggle, verify', { skip: !win, timeout: 120000 }, async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'core-uia-')), 'form.ps1');
  fs.writeFileSync(file, FORM);
  const app = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-STA', '-File', file], { stdio: 'ignore' });
  const uia = new UiaClient({ timeoutMs: 30000 });
  try {
    let w = null;
    for (let i = 0; i < 60 && !w; i++) { await wait(500); w = (await uia.windows()).find((x) => x.name === 'COre UIA Test'); }
    assert.ok(w, 'the app window is found by its title');
    await uia.activate(w.id).catch(() => {});
    let snap = await uia.snapshot({ target: w.id });
    console.log(outline(snap));
    const box = snap.elements.find((e) => e.type === 'Edit');
    const btn = snap.elements.find((e) => e.type === 'Button' && e.name === 'Greet');
    const chk = snap.elements.find((e) => e.type === 'CheckBox' && e.name === 'Remember me');
    assert.ok(box && btn && chk, 'text box, button and check box found by type and name');
    assert.ok(box.bounds && box.bounds.w > 50, 'controls have real screen bounds');
    await uia.setValue(box.id, 'Ada');
    assert.strictEqual((await uia.value(box.id)).value, 'Ada', 'text set and read back');
    assert.strictEqual(await uia.invoke(btn.id), 'invoked');
    assert.strictEqual(await uia.invoke(chk.id), 'toggled');
    await wait(300);
    snap = await uia.snapshot({ target: w.id });
    const label = snap.elements.find((e) => e.type === 'Text' && /^Hello, /.test(e.name));
    assert.ok(label, 'the button really ran: the label changed');
    assert.strictEqual(label.name, 'Hello, Ada');
    assert.strictEqual(snap.elements.find((e) => e.type === 'CheckBox').toggle, 'On', 'the check box is really checked');
  } finally {
    uia.dispose();
    kill(app);
  }
});

test('Notepad: windows and controls visible to UI Automation (logged; the CI desktop may not render its text area)', { skip: !win, timeout: 90000 }, async () => {
  const uia = new UiaClient({ timeoutMs: 30000 });
  const np = spawn('notepad.exe', [], { stdio: 'ignore' });
  try {
    let w = null;
    for (let i = 0; i < 40 && !w; i++) { await wait(500); w = (await uia.windows()).find((x) => /notepad/i.test(x.process)); }
    assert.ok(w, 'Notepad found by its process');
    const snap = await uia.snapshot({ target: w.id, depth: 16, max: 400 });
    console.log(outline(snap, { maxLines: 40 }));
    console.log('types:', JSON.stringify(snap.elements.map((e) => `${e.type}${e.offscreen ? '*' : ''}:${(e.patterns || []).join('+')}`)));
    const edit = snap.elements.find((e) => (e.patterns || []).includes('Value') && ['Edit', 'Document'].includes(e.type));
    if (edit) {
      await uia.setValue(edit.id, 'hello from COre');
      assert.strictEqual((await uia.value(edit.id)).value, 'hello from COre');
      console.log('Notepad text area: set and read back OK');
    } else console.log('Notepad text area not exposed on this desktop');
  } finally {
    uia.dispose();
    kill(np);
  }
});

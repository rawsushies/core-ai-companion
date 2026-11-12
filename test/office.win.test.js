'use strict';

// Office suite on real Windows (CI job office-windows): LibreOffice Calc.
// Runs only with CORE_OFFICE=1 (LibreOffice installed).
//
// Finding (windows-latest, 832badc): on a headless CI desktop Calc exposes only
// its top-level window to UI Automation (its accessibility bridge stays off with
// no assistive technology running). So the scenario uses what COre's agent has
// for such apps: UIA to find and focus the window, its app profile for the
// keyboard route, real key presses through COre's input helper (SendInput), and
// verification from the saved file on disk, not from what the screen claims.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { UiaClient } = require('../src/main/uia');
const { WindowsDriver } = require('../src/main/agent');
const { profileFor } = require('../src/main/appProfiles');

const run = process.platform === 'win32' && process.env.CORE_OFFICE === '1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SOFFICE = ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'].find((p) => fs.existsSync(p));

test('OFFICE: COre edits a real LibreOffice Calc sheet and verifies the saved file', { skip: !run, timeout: 300000 }, async () => {
  assert.ok(SOFFICE, 'LibreOffice installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-calc-'));
  const file = path.join(dir, 'budget.csv');
  fs.writeFileSync(file, 'Item,Cost\r\nFacade,4200000\r\n');
  // The CSV filter options skip the import dialog (comma separated, UTF-8, from line 1).
  const app = spawn(SOFFICE, ['--calc', '--norestore', '--nologo', '--infilter=CSV:44,34,76,1', file], { stdio: 'ignore' });
  const uia = new UiaClient({ timeoutMs: 60000 });
  const keys = new WindowsDriver();
  const key = (combo) => keys.perform({ type: 'key', combo });
  try {
    let w = null;
    for (let i = 0; i < 120 && !w; i++) { await wait(1000); w = (await uia.windows()).find((x) => /budget\.csv/i.test(x.name) && /LibreOffice/i.test(x.name)); }
    assert.ok(w, 'the Calc window with budget.csv is on the desktop');
    console.log('window:', JSON.stringify({ name: w.name, cls: w.cls, process: w.process }));
    const prof = profileFor(w);
    assert.strictEqual(prof && prof.id, 'calc', 'the LibreOffice Calc profile is chosen for this window');

    await uia.activate(w.id);
    await wait(1500);
    // A real click in the sheet area gives Calc the keyboard even when focus-stealing rules block activation.
    const b = w.bounds;
    if (b) { await keys.perform({ type: 'click', button: 'left' }, { x: b.x + Math.round(b.w / 2), y: b.y + Math.round(b.h / 2) }); await wait(800); }
    const fg = (await uia.windows()).find((x) => x.foreground);
    console.log('foreground before typing:', fg && fg.name);
    // The profile's route: Ctrl+Shift+F5 focuses the Name Box; type a cell, Enter jumps there.
    await key('ctrl+shift+f5'); await wait(400);
    await keys.perform({ type: 'type', text: 'A3' }); await key('enter'); await wait(400);
    await keys.perform({ type: 'type', text: 'Glass' }); await key('tab');
    await keys.perform({ type: 'type', text: '900000' }); await key('enter'); await wait(400);
    // Ctrl+S on a CSV asks "Keep current format?": Enter keeps Text CSV.
    await key('ctrl+s'); await wait(2500);
    await key('enter');

    await wait(1500);
    console.log('windows after save:', JSON.stringify((await uia.windows({ owned: true })).map((x) => ({ name: x.name, fg: x.foreground, dialog: x.dialog }))));
    let text = '';
    for (let i = 0; i < 30; i++) { await wait(1000); text = fs.readFileSync(file, 'utf8'); if (/Glass/.test(text)) break; }
    console.log('saved file:', JSON.stringify(text));
    assert.match(text, /Facade,4200000/, 'existing data kept');
    assert.match(text, /Glass,900000/, 'the new row is in the file on disk');
  } finally {
    keys.dispose();
    uia.dispose();
    try { execFileSync('taskkill', ['/IM', 'soffice.bin', '/T', '/F'], { stdio: 'ignore' }); } catch {}
    try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
});

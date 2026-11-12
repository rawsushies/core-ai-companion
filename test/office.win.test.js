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
  // A clean LibreOffice profile for the test, with the "Keep current format?" prompt off
  // (that dialog is as invisible to UI Automation as the rest of LibreOffice).
  const profile = path.join(dir, 'lo-profile');
  fs.mkdirSync(path.join(profile, 'user'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'user', 'registrymodifications.xcu'), '<?xml version="1.0" encoding="UTF-8"?>\n<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n<item oor:path="/org.openoffice.Office.Common/Save/Document"><prop oor:name="WarnAlienFormat" oor:op="fuse"><value>false</value></prop></item>\n<item oor:path="/org.openoffice.Setup/Office"><prop oor:name="ooSetupInstCompleted" oor:op="fuse"><value>true</value></prop></item>\n</oor:items>\n');
  const shots = process.env.CORE_SHOTS || dir;
  const shot = (name) => { try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save('${path.join(shots, name).replace(/'/g, "''")}')`], { stdio: 'ignore', timeout: 20000 }); } catch {} };
  const app = spawn(SOFFICE, [`-env:UserInstallation=file:///${profile.replace(/\\/g, '/')}`, '--calc', '--norestore', '--nologo', '--infilter=CSV:44,34,76,1', file], { stdio: 'ignore' });
  const uia = new UiaClient({ timeoutMs: 60000 });
  const keys = new WindowsDriver();
  const key = (combo) => keys.perform({ type: 'key', combo });
  try {
    let w = null;
    let all = [];
    for (let i = 0; i < 120 && !w; i++) {
      await wait(1000);
      all = await uia.windows();
      w = all.find((x) => /budget\.csv/i.test(x.name) && /LibreOffice|Calc/i.test(x.name));
      // LibreOffice 26 can open a first-start or import question before the sheet: answer it.
      if (!w && i % 5 === 4) {
        const q = all.find((x) => x.process && /soffice/i.test(x.process) && !/budget\.csv/i.test(x.name));
        if (q) { console.log('LibreOffice asks first:', q.name); try { await uia.activate(q.id); await key('enter'); } catch {} }
      }
    }
    if (!w) { shot('calc-0-missing.png'); console.log('windows:', JSON.stringify(all.map((x) => ({ name: x.name, process: x.process, cls: x.cls })))); }
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
    shot('calc-1-open.png');
    // Keyboard route: Ctrl+Home goes to A1, Down twice to A3; Tab moves right.
    await key('ctrl+home'); await wait(300);
    await key('down'); await key('down'); await wait(300);
    await keys.perform({ type: 'type', text: 'Glass' }); await key('tab');
    await keys.perform({ type: 'type', text: '900000' }); await key('enter'); await wait(600);
    shot('calc-2-typed.png');
    await key('ctrl+s'); await wait(3000);
    // Saving a CSV asks whether to keep the format. Older LibreOffice: "Keep Current Format"
    // (Enter keeps it, and the profile setting turns it off); 26.x: "Use Text CSV Format",
    // which ignores that setting. Answer it like COre's Calc profile does: find the button.
    for (let i = 0; i < 5; i++) {
      let snap = null;
      try { snap = await uia.snapshot({ target: 'foreground' }); } catch {}
      const btn = snap && (snap.elements || []).find((e) => /Button/i.test(e.type) && /Use Text CSV Format|Keep Current Format/i.test(String(e.name || '')));
      if (!btn) { await wait(600); continue; }
      console.log('format question answered:', btn.name);
      try { await uia.invoke(btn.id); } catch { const c = btn.bounds; if (c) await keys.perform({ type: 'click', button: 'left' }, { x: c.x + Math.round(c.w / 2), y: c.y + Math.round(c.h / 2) }); }
      await wait(2000);
      break;
    }
    shot('calc-3-saved.png');

    await wait(1500);
    console.log('windows after save:', JSON.stringify((await uia.windows({ owned: true })).map((x) => ({ name: x.name, fg: x.foreground, dialog: x.dialog }))));
    let text = '';
    for (let i = 0; i < 30; i++) { await wait(1000); text = fs.readFileSync(file, 'utf8'); if (/Glass/.test(text)) break; }
    console.log('saved file:', JSON.stringify(text));
    // LibreOffice quotes text cells when it writes CSV ("Facade",4200000): compare unquoted rows.
    const rows = text.split(/\r?\n/).filter(Boolean).map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '')));
    assert.deepStrictEqual(rows[1], ['Facade', '4200000'], 'existing data kept');
    assert.deepStrictEqual(rows[2], ['Glass', '900000'], 'the new row is in the file on disk');
  } finally {
    keys.dispose();
    uia.dispose();
    try { execFileSync('taskkill', ['/IM', 'soffice.bin', '/T', '/F'], { stdio: 'ignore' }); } catch {}
    try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
});

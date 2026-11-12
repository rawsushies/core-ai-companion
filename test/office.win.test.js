'use strict';

// Office suite on real Windows (CI job office-windows): LibreOffice Calc
// through UI Automation. Runs only with CORE_OFFICE=1 (LibreOffice installed).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { UiaClient, outline } = require('../src/main/uia');

const run = process.platform === 'win32' && process.env.CORE_OFFICE === '1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SOFFICE = ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'].find((p) => fs.existsSync(p));

test('LibreOffice Calc: window and controls visible to UI Automation (logged map)', { skip: !run, timeout: 240000 }, async () => {
  assert.ok(SOFFICE, 'LibreOffice installed');
  const app = spawn(SOFFICE, ['--calc', '--norestore', '--nologo'], { stdio: 'ignore', detached: false });
  const uia = new UiaClient({ timeoutMs: 60000 });
  try {
    let w = null;
    for (let i = 0; i < 120 && !w; i++) { await wait(1000); w = (await uia.windows()).find((x) => /LibreOffice Calc/i.test(x.name)); }
    assert.ok(w, 'Calc window found');
    console.log('window:', JSON.stringify({ name: w.name, cls: w.cls, process: w.process }));
    const snap = await uia.snapshot({ target: w.id, depth: 14, max: 400 });
    console.log('elements:', snap.elements.length);
    const interesting = snap.elements.filter((e) => /Name Box|Formula|Input line|A1|B2|Sheet|Cell/i.test(`${e.name} ${e.type}`)).slice(0, 40);
    console.log('interesting:', JSON.stringify(interesting.map((e) => ({ id: e.id, type: e.type, name: e.name, patterns: e.patterns, value: e.value }))));
    console.log('types:', JSON.stringify([...new Set(snap.elements.map((e) => e.type))]));
    if (typeof outline === 'function') console.log('outline:\n' + String(outline(snap)).slice(0, 4000));
    assert.ok(snap.elements.length > 5, 'Calc exposes controls');
  } finally {
    uia.dispose();
    try { execFileSync('taskkill', ['/IM', 'soffice.bin', '/T', '/F'], { stdio: 'ignore' }); } catch {}
    try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
});

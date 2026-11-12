'use strict';

// Real Windows UI Automation against real Notepad. Runs only on Windows (the
// windows-latest CI job and Windows PCs); elsewhere it is skipped.

const test = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('child_process');
const { UiaClient, outline } = require('../src/main/uia');

const win = process.platform === 'win32';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('UI Automation reads and operates real Notepad', { skip: !win, timeout: 90000 }, async () => {
  const uia = new UiaClient({ timeoutMs: 30000 });
  const np = spawn('notepad.exe', [], { detached: false, stdio: 'ignore' });
  try {
    let w = null;
    for (let i = 0; i < 40 && !w; i++) {
      await wait(500);
      w = (await uia.windows()).find((x) => /notepad/i.test(x.process) || /Notepad/.test(x.name));
    }
    assert.ok(w, 'Notepad window found by its process');
    console.log('notepad window:', JSON.stringify({ name: w.name, process: w.process, cls: w.cls }));
    await uia.activate(w.id).catch(() => {});
    const snap = await uia.snapshot({ target: w.id, depth: 14, max: 400 });
    console.log(outline(snap, { maxLines: 40 }));
    console.log('types:', JSON.stringify(snap.elements.map((e) => `${e.type}${e.offscreen ? '*' : ''}:${(e.patterns || []).join('+')}`)));
    const edit = snap.elements.find((e) => (e.patterns || []).includes('Value') && ['Edit', 'Document'].includes(e.type));
    assert.ok(edit, 'the text area is found by its control type and Value pattern');
    await uia.setValue(edit.id, 'hello from COre');
    const v = await uia.value(edit.id);
    assert.strictEqual(v.value, 'hello from COre', 'text set and read back through UI Automation');
    const menu = snap.elements.find((e) => e.type === 'MenuItem' && /^(File|Edit|Format|View|Help)$/.test(e.name));
    assert.ok(menu, 'menu items are listed by name');
    await uia.invoke(menu.id).catch((e) => { if (!e.noPattern) throw e; });
    await wait(400);
    const after = await uia.snapshot({ target: 'foreground', depth: 8, max: 200 }).catch(() => null);
    if (after) console.log('after opening the menu:', after.window.name, after.elements.length, 'controls');
  } finally {
    uia.dispose();
    try { execFileSync('taskkill', ['/PID', String(np.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
});

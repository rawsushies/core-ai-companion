'use strict';

// Real Obsidian on Windows (CI job office-windows, CORE_OBSIDIAN=1): COre's
// automatic setup creates the vault and adds it to Obsidian's vault list; the real
// Obsidian app then opens that vault (checked through UI Automation) and shows the
// note COre's knowledge layer wrote.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { UiaClient } = require('../src/main/uia');
const O = require('../src/main/obsidian');

const run = process.platform === 'win32' && process.env.CORE_OBSIDIAN === '1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Obsidian', 'Obsidian.exe'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Obsidian', 'Obsidian.exe')].find((p) => fs.existsSync(p));

test('OBSIDIAN: COre sets up the vault and the real Obsidian opens it', { skip: !run, timeout: 240000 }, async () => {
  assert.ok(exe, 'Obsidian installed');
  assert.ok(O.obsidianInstalled(), 'COre detects the installed Obsidian');
  const vault = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'core-obs-')), 'COre Vault');
  assert.deepStrictEqual(O.ensureVault(vault), { created: true });
  fs.mkdirSync(path.join(vault, 'Projects'));
  fs.writeFileSync(path.join(vault, 'Projects', 'Tower.md'), '# Tower\n\n## Decisions\n- The client chose a glass facade with bronze mullions\n');
  fs.mkdirSync(path.dirname(O.obsidianConfigPath()), { recursive: true }); // a never-started Obsidian has no list yet
  assert.strictEqual(O.registerVault(vault), 'added');
  const list = JSON.parse(fs.readFileSync(O.obsidianConfigPath(), 'utf8'));
  console.log('obsidian.json vaults:', JSON.stringify(Object.values(list.vaults).map((v) => v.path)));

  const uia = new UiaClient({ timeoutMs: 60000 });
  const app = spawn(exe, [O.noteUri(vault, 'Projects/Tower.md')], { stdio: 'ignore', detached: true });
  try {
    let w = null;
    for (let i = 0; i < 90 && !w; i++) { await wait(1000); w = (await uia.windows()).find((x) => /COre Vault/i.test(x.name) && /Obsidian/i.test(x.name)); }
    console.log('windows:', JSON.stringify((await uia.windows()).map((x) => x.name)));
    assert.ok(w, 'Obsidian opened the COre vault');
    // The title names the open note and vault ("Tower - COre Vault - Obsidian"); the control
    // tree is extra evidence only (Electron's can be slow or empty to UI Automation).
    let text = '';
    try { const fresh = (await uia.windows()).find((x) => x.name === w.name); const snap = await uia.snapshot({ target: fresh.id, depth: 25, max: 600 }); text = snap.elements.map((e) => `${e.name || ''} ${e.value || ''}`).join(' '); } catch (err) { console.log('control tree not read:', err.message); }
    console.log('Obsidian title:', w.name, '| shows:', text.slice(0, 400));
    assert.match(`${w.name} ${text}`, /Tower|Welcome to COre/, 'a vault note is shown');
  } finally {
    uia.dispose();
    try { execFileSync('taskkill', ['/IM', 'Obsidian.exe', '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
});

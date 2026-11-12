'use strict';

// VAULT ACCEPTANCE: COre × Obsidian-compatible vault × Cortex × Syncthing, with
// real files, two real Cortex MCP servers (each with its own local index) and two
// real Syncthing devices syncing over loopback. No mocks.
//
//   Device A: COre (memory gateway) + Cortex A + vault A + Syncthing A
//   Device B: COre (memory gateway) + Cortex B + vault B + Syncthing B
//
// "Obsidian edits" are direct writes to the Markdown files, which is exactly what
// Obsidian does; Obsidian itself is not launched here (no display app in CI).
//
// Needs: syncthing on PATH, a Cortex checkout (CORTEX_DIR), Python.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Memory } = require('../src/main/memory');
const { CortexClient } = require('../src/main/cortex');
const { MemoryGateway } = require('../src/main/memgate');
const { Syncthing, findConflicts, formatStatus } = require('../src/main/vaultsync');
const { noteUri } = require('../src/main/obsidian');

const CORTEX_DIR = process.env.CORTEX_DIR || path.join(__dirname, '..', '..', 'rawsushies', 'cortex-ai-brain');
const PY = process.platform === 'win32' ? 'python' : 'python3';
const has = (cmd, args) => { try { return spawnSync(cmd, args, { encoding: 'utf8' }).status === 0; } catch { return false; } };
const skip = !has('syncthing', ['--version']) ? 'syncthing not installed' : !fs.existsSync(path.join(CORTEX_DIR, 'run.py')) ? 'Cortex checkout not found (set CORTEX_DIR)' : !has(PY, ['--version']) ? 'Python not available' : false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, f, ms = 90000) {
  const end = Date.now() + ms;
  for (;;) {
    let v; try { v = await f(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await wait(500);
  }
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// One Syncthing device, local only (no discovery, relays or NAT), GUI/REST on loopback.
class Device {
  constructor(root, name, gui, listen) { Object.assign(this, { home: path.join(root, `st-${name}`), name, gui, listen }); }
  generate() {
    const r = spawnSync('syncthing', ['generate', `--home=${this.home}`], { encoding: 'utf8', env: { ...process.env, STNODEFAULTFOLDER: '1' } });
    this.id = /Device ID: (\S+)/.exec(`${r.stdout}${r.stderr}`)[1];
    let x = fs.readFileSync(path.join(this.home, 'config.xml'), 'utf8');
    x = x.replace(/<listenAddress>[^<]*<\/listenAddress>/, `<listenAddress>tcp://127.0.0.1:${this.listen}</listenAddress>`)
      .replace(/(<gui\b[\s\S]*?<address>)[^<]*(<\/address>)/, `$1127.0.0.1:${this.gui}$2`);
    for (const k of ['globalAnnounceEnabled', 'localAnnounceEnabled', 'relaysEnabled', 'natEnabled', 'startBrowser', 'crashReportingEnabled']) x = x.replace(new RegExp(`<${k}>true</${k}>`), `<${k}>false</${k}>`);
    x = x.replace(/<urAccepted>[^<]*<\/urAccepted>/, '<urAccepted>-1</urAccepted>');
    fs.writeFileSync(path.join(this.home, 'config.xml'), x);
    this.api = new Syncthing({ address: `127.0.0.1:${this.gui}`, apiKey: /<apikey>([^<]+)<\/apikey>/.exec(x)[1] });
  }
  async start() {
    this.proc = spawn('syncthing', ['serve', `--home=${this.home}`, '--no-browser', '--no-restart', '--no-upgrade'], { stdio: 'ignore', env: { ...process.env, STNODEFAULTFOLDER: '1', STNOUPGRADE: '1' } });
    await until(`${this.name} REST up`, () => this.api.get('/rest/system/ping'), 30000);
  }
  async stop() { if (!this.proc) return; const p = this.proc; this.proc = null; p.kill('SIGTERM'); await new Promise((r) => { p.once('exit', r); setTimeout(r, 5000); }); }
  async share(other, vault) {
    await this.api.request('POST', '/rest/config/devices', { deviceID: other.id, name: other.name, addresses: [`tcp://127.0.0.1:${other.listen}`] });
    await this.api.request('POST', '/rest/config/folders', { id: 'vault', label: 'Knowledge vault', path: vault, type: 'sendreceive', devices: [{ deviceID: this.id }, { deviceID: other.id }], fsWatcherEnabled: true, fsWatcherDelayS: 1, rescanIntervalS: 3600 });
  }
  scan() { return this.api.request('POST', '/rest/db/scan?folder=vault').catch(() => {}); }
}

function cortexFor(vault, localDir) {
  return new CortexClient({ cfg: { command: PY, args: [path.join(CORTEX_DIR, 'run.py'), 'mcp'], vault, env: { CORTEX_LOCAL_DIR: localDir, CORTEX_AUTO_IMPORT: 'off' } }, timeoutMs: 30000 });
}

test('VAULT ACCEPTANCE: COre ↔ vault ↔ Cortex, Obsidian edits, two devices via Syncthing, offline, conflicts, fresh install', { skip, timeout: 600000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-vault-'));
  const vA = path.join(root, 'vault-A'); const vB = path.join(root, 'vault-B');
  fs.mkdirSync(vA); fs.mkdirSync(vB);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const A = new Device(root, 'PC', port, port + 1); const B = new Device(root, 'Laptop', port + 2, port + 3);
  A.generate(); B.generate();
  const cA = cortexFor(vA, path.join(root, 'cortex-local-A')); const cB = cortexFor(vB, path.join(root, 'cortex-local-B'));
  const gA = new MemoryGateway({ memory: new Memory(path.join(root, 'memA.json')), cortex: cA, queueFile: path.join(root, 'qA.json'), recallTimeoutMs: 30000 });
  const gB = new MemoryGateway({ memory: new Memory(path.join(root, 'memB.json')), cortex: cB, queueFile: path.join(root, 'qB.json'), recallTimeoutMs: 30000 });
  const evidence = [];
  const ok = (n, what) => { evidence.push(`${n}. ${what}`); console.log(`PASS ${n}: ${what}`); };
  let fresh = null;
  try {
    await A.start(); await B.start();
    await A.share(B, vA); await B.share(A, vB);
    await until('devices connected', async () => (await A.api.vaultStatus(vA)).devices.some((d) => d.connected));

    // 1. COre creates a memory -> a Markdown note in the vault (what Obsidian shows).
    const r1 = await gA.remember('The Tower client chose a glass facade with bronze mullions', { kind: 'decision', project: 'Tower' });
    assert.strictEqual(r1.stored, 'cortex');
    const towerA = path.join(vA, 'Projects', 'Tower.md');
    assert.match(read(towerA), /bronze mullions/);
    assert.match(noteUri(vA, 'Projects/Tower.md'), /^obsidian:\/\/open\?path=.*Tower\.md$/);
    ok(1, 'COre memory written as Projects/Tower.md (plain Markdown, opens in Obsidian via obsidian://)');

    // 2 + 3. An Obsidian edit (direct file write) and a brand-new note made outside COre are indexed by Cortex and recalled.
    fs.appendFileSync(towerA, '\n- 2026-11-12 Facade budget capped at 4.2M (edited in Obsidian)\n');
    fs.mkdirSync(path.join(vA, 'Notes'), { recursive: true });
    fs.writeFileSync(path.join(vA, 'Notes', 'Site visit.md'), '# Site visit\n\nThe Tower crane is booked for the 18th; scaffolding inspection pending.\n');
    await wait(2500); // Cortex re-checks the disk at most every 2 s
    const m2 = await until('recall sees the Obsidian edit', async () => { const c = await gA.context('Tower facade budget'); return /4\.2M/.test(c.text) && c; });
    ok(2, `Obsidian edit recalled by COre: ${m2.sources.filter((s) => s.system === 'cortex').map((s) => s.path).join(', ')}`);
    const m3 = await until('Cortex indexed the new note', async () => { const c = await gA.context('crane booked scaffolding inspection'); return /crane is booked/.test(c.text) && c; });
    ok(3, `note created outside COre indexed by Cortex and recalled (${m3.sources.find((s) => /Site visit/.test(s.path)).path})`);

    // 4. The second device receives the same knowledge, and its own Cortex index finds it.
    const towerB = path.join(vB, 'Projects', 'Tower.md');
    await until('Tower.md reached device B', () => /4\.2M/.test(read(towerB)) && fs.existsSync(path.join(vB, 'Notes', 'Site visit.md')));
    const m4 = await until('device B recall', async () => { const c = await gB.context('Tower facade bronze mullions'); return /bronze mullions/.test(c.text) && c; });
    ok(4, `device B received the notes via Syncthing and its Cortex recalls them (${m4.sources.filter((s) => s.system === 'cortex').map((s) => s.path).join(', ')})`);

    // 5. A change made on device B comes back to device A.
    assert.strictEqual((await gB.remember('Tower lobby floor will be terrazzo', { kind: 'decision', project: 'Tower' })).stored, 'cortex');
    await until('B change reached A', () => /terrazzo/.test(read(towerA)));
    await until('A recalls B change', async () => /terrazzo/.test((await gA.context('Tower lobby floor')).text));
    ok(5, 'decision made on device B arrived on device A and is recalled there');

    // 6. Offline: device B goes away; both sides keep working; changes meet after reconnection.
    await B.stop();
    await until('A sees B offline', async () => !(await A.api.vaultStatus(vA)).devices.some((d) => d.connected), 30000);
    const offlineStatus = formatStatus({ vault: vA, obsidian: false, cortex: 'ok', sync: await A.api.vaultStatus(vA), conflicts: [] });
    assert.match(offlineStatus, /offline/);
    assert.strictEqual((await gA.remember('Tower roof garden approved by the council', { kind: 'decision', project: 'Tower Roof' })).stored, 'cortex'); // COre keeps working locally
    fs.writeFileSync(path.join(vB, 'Notes', 'Laptop offline.md'), '# Laptop offline\n\nWritten on the train without a connection: check the glazing samples.\n');
    await B.start();
    await until('offline changes exchanged', () => fs.existsSync(path.join(vB, 'Projects', 'Tower Roof.md')) && fs.existsSync(path.join(vA, 'Notes', 'Laptop offline.md')));
    await until('A recalls the offline note from B', async () => /glazing samples/.test((await gA.context('glazing samples train')).text));
    ok(6, 'changes made while device B was offline synchronized both ways after reconnection, and COre kept working locally');

    // 7. Conflict: both devices edit the same note while disconnected; both versions survive.
    await B.stop();
    await until('A sees B offline again', async () => !(await A.api.vaultStatus(vA)).devices.some((d) => d.connected), 30000);
    fs.appendFileSync(towerA, '\n- Facade colour: anthracite (decided on the PC)\n');
    await wait(1100);
    fs.appendFileSync(towerB, '\n- Facade colour: champagne (decided on the laptop)\n');
    await B.start();
    await A.scan(); await B.scan();
    const conflicts = await until('conflict copy appears on A', () => { const c = findConflicts(vA).filter((x) => x.original === 'Projects/Tower.md'); return c.length && c; });
    const both = [read(towerA), ...conflicts.map((c) => read(path.join(vA, c.copy)))].join('\n');
    assert.match(both, /anthracite/); assert.match(both, /champagne/);
    // Cortex's health check names Syncthing copies from rawsushies/cortex-ai-brain#1 on; COre finds them itself either way.
    const cortexKnows = /SYNCTHING_CONFLICT/.test(read(path.join(CORTEX_DIR, 'cortex', 'cloud.py')));
    const health = String(await cA.call('brain_health', {}));
    if (cortexKnows) assert.match(health, /sync-conflict/, 'Cortex health lists the conflict copy');
    const st = formatStatus({ vault: vA, obsidian: false, cortex: 'ok', sync: await A.api.vaultStatus(vA), conflicts: findConflicts(vA) });
    assert.match(st, /two versions/);
    const rc = await gA.context('Facade colour anthracite champagne');
    const flagged = rc.sources.some((s) => s.conflictOf === 'Projects/Tower.md') ? ' and recall flags the second version' : '';
    ok(7, `conflicting edits kept as ${conflicts[0].copy} next to Projects/Tower.md (both versions present, nothing overwritten); ${cortexKnows ? 'Cortex health reports it' : 'COre reports it (this Cortex version predates Syncthing names)'}${flagged}`);

    // 8. A fresh COre installation (new memory, empty Cortex index) reconnects to the existing vault.
    fresh = cortexFor(vB, path.join(root, 'cortex-local-fresh'));
    const gF = new MemoryGateway({ memory: new Memory(path.join(root, 'memFresh.json')), cortex: fresh, queueFile: path.join(root, 'qF.json'), recallTimeoutMs: 30000 });
    const m8 = await until('fresh install recalls', async () => { const c = await gF.context('Tower facade terrazzo lobby'); return /terrazzo/.test(c.text) && c; });
    ok(8, `fresh install with an empty index rebuilt it from the vault and recalled ${m8.sources.filter((s) => s.system === 'cortex').length} note(s)`);

    const out = process.env.VAULT_EVIDENCE;
    if (out) fs.writeFileSync(out, `${evidence.join('\n')}\n`);
  } finally {
    for (const c of [cA, cB, fresh]) try { c && c.dispose(); } catch {}
    await A.stop(); await B.stop();
  }
});

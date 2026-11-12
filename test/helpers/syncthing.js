'use strict';

// Real Syncthing devices for tests: local only (no discovery, relays or NAT), REST on
// loopback, folders shared over 127.0.0.1. Used by test/vault.sync.test.js and the
// installed-app test (test-e2e/installed.e2e.js).

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Syncthing } = require('../../src/main/vaultsync');

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

// One Syncthing device, local only (no discovery, relays or NAT), GUI/REST on loopback.
class Device {
  constructor(root, name, gui, listen) { Object.assign(this, { home: path.join(root, `st-${name}`), name, gui, listen }); }
  generate() {
    const r = spawnSync('syncthing', ['generate', `--home=${this.home}`], { encoding: 'utf8', env: { ...process.env, STNODEFAULTFOLDER: '1' } });
    const m = /Device ID:?\s*([A-Z0-9]{7}(?:-[A-Z0-9]{7}){7})/.exec(`${r.stdout}${r.stderr}`);
    this.id = m ? m[1] : null; // also read from the REST API after start (log formats differ between versions)
    let x = fs.readFileSync(path.join(this.home, 'config.xml'), 'utf8');
    x = x.replace(/<listenAddress>[^<]*<\/listenAddress>/, `<listenAddress>tcp://127.0.0.1:${this.listen}</listenAddress>`)
      .replace(/(<gui\b[\s\S]*?<address>)[^<]*(<\/address>)/, `$1127.0.0.1:${this.gui}$2`);
    for (const k of ['globalAnnounceEnabled', 'localAnnounceEnabled', 'relaysEnabled', 'natEnabled', 'startBrowser', 'crashReportingEnabled']) x = x.replace(new RegExp(`<${k}>true</${k}>`), `<${k}>false</${k}>`);
    x = x.replace(/<urAccepted>[^<]*<\/urAccepted>/, '<urAccepted>-1</urAccepted>');
    fs.writeFileSync(path.join(this.home, 'config.xml'), x);
    this.api = new Syncthing({ address: `127.0.0.1:${this.gui}`, apiKey: /<apikey>([^<]+)<\/apikey>/.exec(x)[1] });
  }
  async start() {
    // Only flags every version accepts; restarts and upgrades are switched off through the environment.
    this.proc = spawn('syncthing', ['serve', `--home=${this.home}`, '--no-browser'], { stdio: 'ignore', env: { ...process.env, STNODEFAULTFOLDER: '1', STNOUPGRADE: '1', STNORESTART: '1' } });
    await until(`${this.name} REST up`, () => this.api.get('/rest/system/ping'), 60000);
    this.id = (await this.api.get('/rest/system/status')).myID;
  }
  async stop() { if (!this.proc) return; const p = this.proc; this.proc = null; p.kill('SIGTERM'); await new Promise((r) => { p.once('exit', r); setTimeout(r, 5000); }); }
  async share(other, vault) {
    await this.api.request('POST', '/rest/config/devices', { deviceID: other.id, name: other.name, addresses: [`tcp://127.0.0.1:${other.listen}`] });
    await this.api.request('POST', '/rest/config/folders', { id: 'vault', label: 'Knowledge vault', path: vault, type: 'sendreceive', devices: [{ deviceID: this.id }, { deviceID: other.id }], fsWatcherEnabled: true, fsWatcherDelayS: 1, rescanIntervalS: 3600 });
  }
  scan() { return this.api.request('POST', '/rest/db/scan?folder=vault').catch(() => {}); }
}


module.exports = { Device, until, wait };

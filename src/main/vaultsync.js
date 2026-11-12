'use strict';

// Vault sync awareness. The knowledge layer is one Obsidian-compatible Markdown
// vault (the source of truth), indexed locally by Cortex, edited by people in
// Obsidian, and carried between devices by Syncthing (free, peer to peer). COre
// is not a sync engine: it only READS Syncthing's status through its local REST
// API and finds the conflict copies sync apps leave when two devices edited the
// same note. It never resolves a conflict by itself: both versions stay until
// the user merges them (in Obsidian), and recall says that two versions exist.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Conflict copies, by sync app:
//   Syncthing      Plan.sync-conflict-20261112-091500-ABCDEFG.md
//   Drive/Dropbox  Plan (conflict 2026-11-08).md, Plan (Ana's conflicted copy).md, Plan [Conflict].md
const SYNCTHING_RE = /^(.*)\.sync-conflict-\d{8}-\d{6}(?:-[A-Z0-9]{7})?\.md$/i;
const BRACKET_RE = /\s*[([][^()[\]]*\bconflict(?:ed copy)?\b[^()[\]]*[)\]]/i;
function conflictOriginal(rel) {
  const p = String(rel || '').replace(/\\/g, '/');
  const m = SYNCTHING_RE.exec(p);
  if (m) return `${m[1]}.md`;
  if (/\.md$/i.test(p) && BRACKET_RE.test(path.posix.basename(p))) return p.slice(0, -3).replace(BRACKET_RE, '').trim() + '.md';
  return null;
}

const SKIP = new Set(['.cortex', '.obsidian', '.git', '.trash', '.stfolder', '.stversions', 'node_modules']);
// -> [{ copy, original, originalExists }] (read-only walk; capped for huge vaults)
function findConflicts(vault, { max = 20000 } = {}) {
  const out = [];
  if (!vault || !fs.existsSync(vault)) return out;
  let seen = 0;
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (seen++ > max) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), r); continue; }
      const orig = conflictOriginal(r);
      if (orig) out.push({ copy: r, original: orig, originalExists: fs.existsSync(path.join(vault, orig)) });
    }
  };
  walk(vault, '');
  return out;
}

// Syncthing's own config (API key + GUI address), from its standard locations.
function syncthingConfigPaths(env = process.env, home = os.homedir(), platform = process.platform) {
  if (env.STHOMEDIR) return [path.join(env.STHOMEDIR, 'config.xml')];
  if (platform === 'win32') return [path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Syncthing', 'config.xml')];
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Syncthing', 'config.xml')];
  return [path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'syncthing', 'config.xml'), path.join(home, '.config', 'syncthing', 'config.xml')];
}
function readSyncthingConfig(file) {
  try {
    const x = fs.readFileSync(file, 'utf8');
    const gui = /<gui\b[^>]*>([\s\S]*?)<\/gui>/.exec(x);
    if (!gui) return null;
    const apiKey = (/<apikey>([^<]+)<\/apikey>/.exec(gui[1]) || [])[1];
    const address = (/<address>([^<]+)<\/address>/.exec(gui[1]) || [])[1] || '127.0.0.1:8384';
    const tls = /<gui\b[^>]*tls="true"/.test(gui[0]);
    return apiKey ? { apiKey, address, tls, file } : null;
  } catch { return null; }
}

class Syncthing {
  // cfg: { address, apiKey } (else read from Syncthing's config.xml)
  constructor(cfg = null, { timeoutMs = 3000 } = {}) {
    this.cfg = cfg || syncthingConfigPaths().map(readSyncthingConfig).find(Boolean) || null;
    this.timeoutMs = timeoutMs;
  }
  get configured() { return !!(this.cfg && this.cfg.apiKey); }

  // Only plain-HTTP loopback GUIs are queried (the default); COre never sends the key elsewhere.
  request(method, p, body) {
    return new Promise((resolve, reject) => {
      if (!this.configured) return reject(new Error('Syncthing not found'));
      if (this.cfg.tls) return reject(new Error('Syncthing GUI uses HTTPS; COre reads only a loopback HTTP GUI'));
      const [host, port] = String(this.cfg.address).replace(/^https?:\/\//, '').split(':');
      if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(host)) return reject(new Error('Syncthing GUI is not on this computer'));
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({ host: host === 'localhost' ? '127.0.0.1' : host, port: Number(port) || 8384, path: p, method, timeout: this.timeoutMs, headers: { 'X-API-Key': this.cfg.apiKey, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
        let t = '';
        res.on('data', (d) => { t += d; });
        res.on('end', () => { if (res.statusCode >= 300) return reject(new Error(`Syncthing ${res.statusCode}: ${t.slice(0, 120)}`)); try { resolve(t ? JSON.parse(t) : null); } catch { resolve(t); } });
      });
      req.on('timeout', () => req.destroy(new Error('Syncthing did not answer')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }
  get(p) { return this.request('GET', p); }

  // Status of the Syncthing folder that holds this vault.
  // -> { running, folder: {id,label,path}|null, state, needFiles, errors, devices: [{ name, connected }], lastScan }
  async vaultStatus(vault) {
    if (!this.configured) return { running: false, reason: 'Syncthing is not installed or not set up on this computer' };
    try {
      const folders = await this.get('/rest/config/folders');
      const norm = (p) => path.resolve(String(p || '').replace(/^~(?=$|[\\/])/, os.homedir())).replace(/[\\/]+$/, '').toLowerCase();
      const f = (folders || []).find((x) => norm(x.path) === norm(vault));
      if (!f) return { running: true, folder: null, reason: 'the vault folder is not shared in Syncthing' };
      const [st, conns, devs, me] = await Promise.all([
        this.get(`/rest/db/status?folder=${encodeURIComponent(f.id)}`),
        this.get('/rest/system/connections'),
        this.get('/rest/config/devices'),
        this.get('/rest/system/status'),
      ]);
      const names = Object.fromEntries((devs || []).map((d) => [d.deviceID, d.name || d.deviceID.slice(0, 7)]));
      const devices = (f.devices || []).filter((d) => d.deviceID !== me.myID).map((d) => ({ name: names[d.deviceID] || d.deviceID.slice(0, 7), connected: !!(conns.connections[d.deviceID] || {}).connected }));
      return { running: true, folder: { id: f.id, label: f.label, path: f.path, paused: !!f.paused }, state: st.state, needFiles: st.needFiles || 0, errors: st.errors || st.pullErrors || 0, devices, lastScan: st.stateChanged };
    } catch (err) {
      return { running: false, reason: /ECONNREFUSED|did not answer/.test(err.message) ? 'Syncthing is not running' : err.message };
    }
  }
}

function formatStatus({ vault, obsidian, cortex, sync, conflicts }) {
  const lines = [`Vault: ${vault || 'not set'}${obsidian ? ' (opened in Obsidian before)' : ''}`, `Cortex index: ${cortex}`];
  if (sync.folder) {
    const on = sync.devices.filter((d) => d.connected).map((d) => d.name);
    lines.push(`Syncthing: ${sync.folder.paused ? 'paused' : sync.state}${sync.needFiles ? `, ${sync.needFiles} file(s) still to receive` : ''}; devices: ${sync.devices.map((d) => `${d.name} (${d.connected ? 'connected' : 'offline'})`).join(', ') || 'none'}${on.length ? '' : '. Changes wait until a device is back; COre keeps working locally.'}`);
  } else lines.push(`Syncthing: ${sync.reason || 'not in use'}. COre and Cortex work locally either way.`);
  if (conflicts.length) {
    lines.push(`${conflicts.length} note(s) have two versions (edited on two devices at once). Both are kept until you merge them:`);
    for (const c of conflicts.slice(0, 10)) lines.push(`- ${c.original}${c.originalExists ? '' : ' (original missing)'} ↔ ${c.copy}  → /obsidian ${c.copy}`);
  } else lines.push('No sync conflicts.');
  return lines.join('\n');
}

module.exports = { conflictOriginal, findConflicts, syncthingConfigPaths, readSyncthingConfig, Syncthing, formatStatus };

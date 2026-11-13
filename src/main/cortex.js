'use strict';

// Cortex (https://github.com/rawsushies/cortex-ai-brain): the user's long-term
// knowledge vault, reached through its MCP server over stdio (newline-delimited
// JSON-RPC 2.0). COre never touches the vault files itself; every read and
// write goes through Cortex's own tools, so its versioning, links and logbook
// stay authoritative. History import stays off: COre starts Cortex with
// CORTEX_AUTO_IMPORT=off and never calls an import tool.

const { spawn } = require('child_process');

class CortexClient {
  // cfg: { command, args: [...], vault, cwd }; e.g. command 'python3',
  // args ['/path/run.py', 'mcp', '--vault', '/path/vault'] or 'Cortex.exe' ['mcp', '--vault', ...].
  // onEvent(name, params): Cortex's push events (notifications/cortex/<name>: changed, task_due),
  // asked for in initialize; older Cortex versions simply never send them.
  constructor({ cfg = {}, spawnImpl = spawn, timeoutMs = 15000, onLog = () => {}, onEvent = null } = {}) {
    this.cfg = cfg;
    this.spawn = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.onLog = onLog;
    this.onEvent = onEvent;
    this.info = null;
    this.caps = null;
    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.seq = 0;
    this.lastError = '';
    this.down = 0;
  }

  configured() { return !!(this.cfg && this.cfg.command); }

  args() {
    const a = Array.isArray(this.cfg.args) ? this.cfg.args.map(String) : [];
    if (this.cfg.vault && !a.includes('--vault')) a.push('--vault', String(this.cfg.vault));
    return a;
  }

  _start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let p;
      try {
        p = this.spawn(this.cfg.command, this.args(), {
          cwd: this.cfg.cwd || undefined, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...(this.cfg.env || {}), CORTEX_AGENT: 'core', CORTEX_AUTO_IMPORT: 'off', PYTHONIOENCODING: 'utf-8' },
        });
      } catch (err) { this.ready = null; reject(err); return; }
      this.proc = p;
      let buf = '';
      let err = '';
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          for (const m of [].concat(msg)) {
            if (m && m.id === undefined && typeof m.method === 'string') {
              if (m.method.startsWith('notifications/cortex/') && this.onEvent) {
                try { this.onEvent(m.method.slice('notifications/cortex/'.length), m.params || {}); } catch {}
              }
              continue;
            }
            const q = this.pending.get(m.id);
            if (!q) continue;
            this.pending.delete(m.id);
            clearTimeout(q.timer);
            if (m.error) q.reject(new Error(String(m.error.message || 'Cortex error'))); else q.resolve(m.result);
          }
        }
      });
      if (p.stderr) { p.stderr.setEncoding('utf8'); p.stderr.on('data', (d) => { err = (err + d).slice(-1500); }); }
      const fail = (why) => {
        this.lastError = why;
        if (this.proc === p) { this.proc = null; this.ready = null; }
        this.down = Date.now() + 30000; // don't hammer a broken setup
        for (const [, q] of this.pending) { clearTimeout(q.timer); q.reject(new Error(why)); }
        this.pending.clear();
      };
      p.on('error', (e) => { fail(`Cortex could not start: ${e.message}`); reject(new Error(this.lastError)); });
      p.on('exit', (code) => fail(`Cortex stopped (${code})${err ? `: ${err.trim().split('\n').pop()}` : ''}`));
      const capabilities = this.onEvent ? { experimental: { cortex: { events: true } } } : {};
      this._rpc('initialize', { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'core', version: '2.2' } })
        .then((r) => {
          this.info = r && r.serverInfo;
          const c = r && r.capabilities && r.capabilities.experimental && r.capabilities.experimental.cortex;
          this.caps = c && typeof c === 'object' ? { contract: Number(c.contract) || 0, features: Array.isArray(c.features) ? c.features.map(String) : [] } : { contract: 0, features: [] };
          this._send({ jsonrpc: '2.0', method: 'notifications/initialized' }); this.lastError = ''; this.down = 0; resolve(r);
        })
        .catch((e) => { this.ready = null; reject(e); });
    });
    return this.ready;
  }

  _send(obj) { this.proc.stdin.write(`${JSON.stringify(obj)}\n`); }

  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc) { reject(new Error(this.lastError || 'Cortex is not running')); return; }
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Cortex timed out (${method})`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this._send({ jsonrpc: '2.0', id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  available() { return this.configured() && Date.now() >= this.down; }

  // -> text of the tool result. Tools: brain_recall, brain_search, brain_read,
  // brain_write, brain_edit, brain_log, brain_capture, brain_context, brain_health...
  async call(name, args = {}) { return (await this.callData(name, args)).text; }

  // -> { text, data }: data is the tool's structured result (Cortex 1.6+, see its CONTRACT.md),
  // or null from an older Cortex; then callers fall back to the text.
  async callData(name, args = {}) {
    if (!this.configured()) throw new Error('Cortex is not set up (Settings, Privacy and memory).');
    if (Date.now() < this.down) throw new Error(this.lastError || 'Cortex is unavailable');
    await this._start();
    const r = await this._rpc('tools/call', { name, arguments: args });
    const text = (r && Array.isArray(r.content) ? r.content : []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r && r.isError) throw new Error(text || `Cortex ${name} failed`);
    const data = r && r.structuredContent && typeof r.structuredContent === 'object' ? r.structuredContent : null;
    return { text, data };
  }

  // What this Cortex can do: { contract, features } (contract 0 / no features = a pre-1.6 Cortex).
  async contract() { await this._start(); return this.caps || { contract: 0, features: [] }; }

  async has(feature) { try { return (await this.contract()).features.includes(feature); } catch { return false; } }

  async tools() { await this._start(); const r = await this._rpc('tools/list', {}); return (r && r.tools || []).map((t) => t.name); }

  dispose() { if (this.proc) { try { this.proc.stdin.end(); this.proc.kill(); } catch {} } this.proc = null; this.ready = null; }
}

// How COre starts Cortex. Settings win; otherwise the Cortex.exe bundled with the
// installer (resources/cortex). The vault: the setting, else the vault Cortex itself
// already uses (CORTEX_VAULT / Cortex's config), else "COre Vault" in Documents.
// c: config.memory.cortex; o: { resourcesPath, platform, documents, env, home, exists }
function resolveCortex(c = {}, o = {}) {
  const pth = require('path');
  const { vaultPath } = require('./obsidian');
  const exists = o.exists || require('fs').existsSync;
  const platform = o.platform || process.platform;
  let command = c.command || '';
  let args = [...(c.script ? [c.script] : []), 'mcp'];
  let bundled = false;
  if (!command && o.resourcesPath) {
    const exe = pth.join(o.resourcesPath, 'cortex', platform === 'win32' ? 'Cortex.exe' : 'Cortex');
    if (exists(exe)) { command = exe; args = ['mcp']; bundled = true; }
  }
  const vault = vaultPath(c.vault, o.env || process.env, o.home) || (o.documents ? pth.join(o.documents, 'COre Vault') : '');
  return { command, args, vault, bundled };
}

module.exports = { CortexClient, resolveCortex };

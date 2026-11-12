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
  constructor({ cfg = {}, spawnImpl = spawn, timeoutMs = 15000, onLog = () => {} } = {}) {
    this.cfg = cfg;
    this.spawn = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.onLog = onLog;
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
      this._rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'core', version: '2.1' } })
        .then((r) => { this._send({ jsonrpc: '2.0', method: 'notifications/initialized' }); this.lastError = ''; this.down = 0; this.info = r && r.serverInfo; resolve(r); })
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
  async call(name, args = {}) {
    if (!this.configured()) throw new Error('Cortex is not set up (Settings, Privacy and memory).');
    if (Date.now() < this.down) throw new Error(this.lastError || 'Cortex is unavailable');
    await this._start();
    const r = await this._rpc('tools/call', { name, arguments: args });
    const text = (r && Array.isArray(r.content) ? r.content : []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r && r.isError) throw new Error(text || `Cortex ${name} failed`);
    return text;
  }

  async tools() { await this._start(); const r = await this._rpc('tools/list', {}); return (r && r.tools || []).map((t) => t.name); }

  dispose() { if (this.proc) { try { this.proc.stdin.end(); this.proc.kill(); } catch {} } this.proc = null; this.ready = null; }
}

module.exports = { CortexClient };

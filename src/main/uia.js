'use strict';

// Windows UI Automation for the desktop agent: windows and controls by their
// real properties (type, name, automation id, value, state, bounds) instead of
// only pixels. Talks to one long-running PowerShell helper (ps/uia-helper.ps1)
// over JSON lines; the helper is a plain file run with -File (no encoded
// commands, no policy bypass).

const path = require('path');
const { spawn } = require('child_process');

const HELPER = path.join(__dirname, 'ps', 'uia-helper.ps1');

class UiaClient {
  constructor({ spawnImpl = spawn, timeoutMs = 15000 } = {}) {
    this.spawn = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.pending = new Map();
    this.seq = 0;
    this.last = null; // latest snapshot
  }

  static supported(platform = process.platform) { return platform === 'win32'; }

  _ensure() {
    if (this.proc) return this.proc;
    const p = this.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', HELPER], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
        if (!line.startsWith('{')) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const q = this.pending.get(msg.id);
        if (!q) continue;
        this.pending.delete(msg.id);
        clearTimeout(q.timer);
        if (msg.ok) q.resolve(msg.result); else q.reject(Object.assign(new Error(String(msg.error || 'UI Automation failed')), { noPattern: /^NO_PATTERN/.test(String(msg.error)) }));
      }
    });
    if (p.stderr) { p.stderr.setEncoding('utf8'); p.stderr.on('data', (d) => { err = (err + d).slice(-2000); }); }
    const fail = (why) => {
      if (this.proc === p) this.proc = null;
      for (const [, q] of this.pending) { clearTimeout(q.timer); q.reject(new Error(why)); }
      this.pending.clear();
    };
    p.on('exit', (code) => fail(`UI Automation helper stopped (${code})${err ? `: ${err.trim().split('\n').pop()}` : ''}`));
    p.on('error', (e) => fail(`UI Automation helper could not start: ${e.message}`));
    return p;
  }

  request(op, args = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`UI Automation timed out (${op})`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this._ensure().stdin.write(`${JSON.stringify({ id, op, ...args })}\n`); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  async windows() { return (await this.request('windows')).windows || []; }

  // target: 'foreground' or a window id from windows().
  async snapshot({ target = 'foreground', depth = 12, max = 300 } = {}) {
    const r = await this.request('snapshot', { target, depth, max });
    this.last = { window: r.window || {}, elements: Array.isArray(r.elements) ? r.elements : (r.elements ? [r.elements] : []), errors: [].concat(r.errors || []), at: Date.now() };
    return this.last;
  }

  element(id) { return this.last && this.last.elements.find((e) => e.id === Number(id)) || null; }
  invoke(el) { return this.request('invoke', { el: Number(el) }); }
  setValue(el, text) { return this.request('setvalue', { el: Number(el), text: String(text) }); }
  value(el) { return this.request('value', { el: Number(el) }); }
  focus(el) { return this.request('focus', { el: Number(el) }); }
  expand(el) { return this.request('expand', { el: Number(el) }); }
  collapse(el) { return this.request('collapse', { el: Number(el) }); }
  scroll(el, dir = 'down') { return this.request('scroll', { el: Number(el), dir: dir === 'up' ? 'up' : 'down' }); }
  activate(el) { return this.request('activate', { el: Number(el) }); }

  dispose() {
    if (this.proc) { try { this.proc.stdin.end(); this.proc.kill(); } catch {} this.proc = null; }
  }
}

// Controls worth showing the brain: anything it can act on or read, plus
// named structure. Layout-only panes without a name are skipped.
const ACTIONABLE = /Invoke|Toggle|SelectionItem|ExpandCollapse|Value|Scroll|RangeValue/;
const TYPES_KEPT = new Set(['Button', 'Edit', 'Document', 'MenuItem', 'MenuBar', 'Menu', 'CheckBox', 'RadioButton', 'ComboBox', 'ListItem', 'TabItem', 'TreeItem', 'Hyperlink', 'Text', 'Slider', 'Spinner', 'SplitButton', 'DataItem', 'Window', 'ToolBar', 'List', 'Tree', 'Tab', 'Group', 'Table', 'Header', 'HeaderItem']);

function interesting(e) {
  const pats = (e.patterns || []).join(' ');
  if (e.type === 'Text') return !!e.name && e.name.length <= 120;
  if (ACTIONABLE.test(pats)) return true;
  return TYPES_KEPT.has(e.type) && !!e.name;
}

// Compact, token-cheap outline for the agent prompt.
function outline(snap, { maxLines = 90 } = {}) {
  if (!snap) return '';
  const w = snap.window || {};
  const lines = [];
  for (const e of snap.elements || []) {
    if (!interesting(e)) continue; // controls without a position still work with control actions
    const q = (s, n = 60) => JSON.stringify(String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
    const bits = [`[${e.id}]`, e.type, e.name ? q(e.name) : ''];
    if (e.aid && e.aid !== e.name && e.aid.length <= 40) bits.push(`#${e.aid}`);
    if (e.value != null && e.value !== '' && e.type !== 'Text') bits.push(`value=${q(e.value, 80)}`);
    if (e.toggle) bits.push(e.toggle === 'On' ? '(checked)' : '(unchecked)');
    if (e.expanded && e.expanded !== 'LeafNode') bits.push(`(${e.expanded.toLowerCase()})`);
    if (e.enabled === false) bits.push('(disabled)');
    if (e.focused) bits.push('(focused)');
    if (!e.bounds) bits.push('(no position)');
    lines.push(`${'  '.repeat(Math.min(6, Math.max(0, (e.depth || 0) - 1)))}${bits.filter(Boolean).join(' ')}`);
    if (lines.length >= maxLines) { lines.push('…(more controls not shown)'); break; }
  }
  return `Window "${w.name || '?'}" (${w.process || 'app'}). Controls:\n${lines.join('\n') || '(none readable)'}`;
}

function center(e) { return e && e.bounds ? { x: Math.round(e.bounds.x + e.bounds.w / 2), y: Math.round(e.bounds.y + e.bounds.h / 2) } : null; }

module.exports = { UiaClient, outline, interesting, center, HELPER };

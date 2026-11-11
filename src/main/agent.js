'use strict';

// Desktop agent (off by default): COre works through a task on your desktop,
// one step at a time. Each step it looks at a fresh screenshot, picks ONE
// action from a fixed set, you approve it (unless you allowed the whole task),
// and a fixed driver performs it. Esc / the stop button / any message ends it.
//
// Safety rules:
//  - The model never produces commands, only an action object that is
//    validated here (type, bounds, length, key allowlist).
//  - Drivers take parameters as data: execFile argument arrays (Linux) or JSON
//    lines to a fixed PowerShell helper (Windows). Nothing is built into a shell
//    string from model text.
//  - Hard step limit; every step is logged (logs/tools.log) and shown in chat.

const { execFile, spawn } = require('child_process');

const KEY_RE = /^((ctrl|control|alt|shift|super|win|cmd|meta)\+){0,3}([a-z0-9]|f([1-9]|1[0-2])|enter|return|tab|escape|esc|backspace|delete|del|up|down|left|right|home|end|pageup|pagedown|space|insert|minus|plus|comma|period|slash)$/i;
// Combos that end the session, lock the PC or open a system-level escape hatch.
const BLOCKED_KEYS = new Set(['ctrl+alt+delete', 'ctrl+alt+del', 'super+l', 'win+l', 'ctrl+shift+escape', 'ctrl+shift+esc', 'alt+f4']);

const SAFE = new Set(['wait', 'scroll', 'move', 'done', 'ask']); // nothing changes on screen beyond viewing

// Validate one action from the model against the screenshot size.
// Returns { action } or { error }.
function validateAction(raw, shot) {
  if (!raw || typeof raw !== 'object') return { error: 'not an action' };
  const type = String(raw.type || '').toLowerCase();
  const why = String(raw.why || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 160);
  const W = shot ? shot.width : 1e5;
  const H = shot ? shot.height : 1e5;
  const xy = () => {
    const x = Math.round(Number(raw.x));
    const y = Math.round(Number(raw.y));
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= W || y >= H) return null;
    return { x, y };
  };
  switch (type) {
    case 'click': {
      const p = xy();
      if (!p) return { error: 'click outside the screenshot' };
      const button = ['left', 'right', 'middle'].includes(raw.button) ? raw.button : 'left';
      return { action: { type, ...p, button, double: !!raw.double, why } };
    }
    case 'move': {
      const p = xy();
      return p ? { action: { type, ...p, why } } : { error: 'move outside the screenshot' };
    }
    case 'type': {
      const text = String(raw.text == null ? '' : raw.text);
      if (!text || text.length > 500) return { error: 'type needs 1-500 characters' };
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return { error: 'type text has control characters' };
      return { action: { type, text, why } };
    }
    case 'key': {
      const combo = String(raw.combo || raw.key || '').toLowerCase().replace(/\s+/g, '');
      if (!KEY_RE.test(combo)) return { error: `key ${combo} is not allowed` };
      if (BLOCKED_KEYS.has(combo)) return { error: `key ${combo} is blocked` };
      return { action: { type, combo, why } };
    }
    case 'scroll': {
      const dy = Math.max(-20, Math.min(20, Math.round(Number(raw.dy) || 0)));
      if (!dy) return { error: 'scroll needs dy' };
      const p = xy();
      return { action: { type, dy, ...(p || {}), why } };
    }
    case 'open': {
      const app = String(raw.app || '').slice(0, 40);
      return app ? { action: { type, app, why } } : { error: 'open needs an app' };
    }
    case 'wait': return { action: { type, ms: Math.max(200, Math.min(5000, Math.round(Number(raw.ms) || 1000))), why } };
    case 'done': return { action: { type, summary: String(raw.summary || '').slice(0, 600), why } };
    case 'ask': return { action: { type, question: String(raw.question || '').slice(0, 300), why } };
    default: return { error: `unknown action ${type}` };
  }
}

// Find the single [[act {...}]] tag in a reply.
function extractAction(reply) {
  const m = /\[\[act\s+(\{[\s\S]*?\})\s*\]\]/.exec(String(reply || ''));
  if (!m) return { error: 'no [[act ...]] in the reply' };
  try { return { raw: JSON.parse(m[1]) }; } catch { return { error: 'the action is not valid JSON' }; }
}

// Screenshot pixels -> physical screen pixels for the driver.
function toScreen(p, shot) {
  const sx = (shot.displayWidth / shot.width) * (shot.scaleFactor || 1);
  const sy = (shot.displayHeight / shot.height) * (shot.scaleFactor || 1);
  return { x: Math.round((shot.displayX || 0) * (shot.scaleFactor || 1) + p.x * sx), y: Math.round((shot.displayY || 0) * (shot.scaleFactor || 1) + p.y * sy) };
}

function describe(a) {
  switch (a.type) {
    case 'click': return `${a.double ? 'Double-click' : a.button === 'right' ? 'Right-click' : 'Click'} at ${a.x}, ${a.y}`;
    case 'move': return `Move the pointer to ${a.x}, ${a.y}`;
    case 'type': return `Type "${a.text.length > 60 ? `${a.text.slice(0, 60)}…` : a.text}"`;
    case 'key': return `Press ${a.combo}`;
    case 'scroll': return `Scroll ${a.dy > 0 ? 'down' : 'up'} ${Math.abs(a.dy)}`;
    case 'open': return `Open ${a.app}`;
    case 'wait': return `Wait ${(a.ms / 1000).toFixed(1)} s`;
    case 'done': return 'Done';
    case 'ask': return `Question: ${a.question}`;
    default: return a.type;
  }
}

// ------------------------------------------------------------------ drivers

const XDO_KEYS = { enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'BackSpace', delete: 'Delete', del: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', space: 'space', insert: 'Insert', minus: 'minus', plus: 'plus', comma: 'comma', period: 'period', slash: 'slash', control: 'ctrl', win: 'super', cmd: 'super', meta: 'super' };

class LinuxDriver {
  constructor({ run = (args) => new Promise((res, rej) => execFile('xdotool', args, { timeout: 15000 }, (e) => (e ? rej(e) : res()))) } = {}) { this.run = run; }
  static xdoCombo(combo) { return combo.split('+').map((k) => XDO_KEYS[k] || (k.length === 1 || /^f\d+$/.test(k) ? k : k)).join('+'); }
  // `mousemove --sync` waits for the pointer to arrive, which fails under some
  // window managers / compositors: retry once without it.
  async move(x, y, rest = []) {
    try { return await this.run(['mousemove', '--sync', String(x), String(y), ...rest]); } catch {
      await this.run(['mousemove', String(x), String(y)]);
      await new Promise((r) => setTimeout(r, 60));
      if (rest.length) return this.run(rest);
      return undefined;
    }
  }
  async perform(a, p) {
    if (a.type === 'click') return this.move(p.x, p.y, ['click', ...(a.double ? ['--repeat', '2'] : []), a.button === 'right' ? '3' : a.button === 'middle' ? '2' : '1']);
    if (a.type === 'move') return this.move(p.x, p.y);
    if (a.type === 'type') return this.run(['type', '--delay', '12', '--', a.text]);
    if (a.type === 'key') return this.run(['key', '--clearmodifiers', LinuxDriver.xdoCombo(a.combo)]);
    if (a.type === 'scroll') {
      const wheel = ['click', '--repeat', String(Math.abs(a.dy)), a.dy > 0 ? '5' : '4'];
      return p ? this.move(p.x, p.y, wheel) : this.run(wheel);
    }
    return undefined;
  }
}

// Windows: one fixed PowerShell helper (C# SendInput) that reads JSON lines.
// The script is a plain file shipped with the app (src/main/ps/input-helper.ps1), run
// with -File: no encoded commands and no execution-policy bypass, which antivirus
// heuristics rightly treat as suspicious.
const WIN_HELPER_FILE = require('path').join(__dirname, 'ps', 'input-helper.ps1');
const WIN_HELPER = require('fs').readFileSync(WIN_HELPER_FILE, 'utf8');

const VK = { ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, super: 0x5b, win: 0x5b, cmd: 0x5b, meta: 0x5b, enter: 0x0d, return: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b, backspace: 0x08, delete: 0x2e, del: 0x2e, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, space: 0x20, insert: 0x2d, minus: 0xbd, plus: 0xbb, comma: 0xbc, period: 0xbe, slash: 0xbf };
function vkCodes(combo) {
  return combo.split('+').map((k) => {
    if (VK[k]) return VK[k];
    if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
    const f = /^f(\d+)$/.exec(k);
    return f ? 0x6f + Number(f[1]) : null;
  }).filter((v) => v != null);
}

class WindowsDriver {
  constructor() { this.proc = null; this.queue = []; }
  _ensure() {
    if (this.proc) return this.proc;
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', WIN_HELPER_FILE], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const q = this.queue.shift();
        if (q) (line === 'ok' ? q.resolve() : q.reject(new Error('input failed')));
      }
    });
    this.proc.on('exit', () => { this.proc = null; for (const q of this.queue.splice(0)) q.reject(new Error('input helper stopped')); });
    return this.proc;
  }
  _send(cmd) {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this._ensure().stdin.write(`${JSON.stringify(cmd)}\n`);
    });
  }
  async perform(a, p) {
    if (a.type === 'click') return this._send({ op: 'click', x: p.x, y: p.y, button: a.button, double: a.double });
    if (a.type === 'move') return this._send({ op: 'move', x: p.x, y: p.y });
    if (a.type === 'type') return this._send({ op: 'type', text: a.text });
    if (a.type === 'key') return this._send({ op: 'key', down: vkCodes(a.combo) });
    if (a.type === 'scroll') return this._send({ op: 'wheel', dy: a.dy, ...(p || {}) });
    return undefined;
  }
  dispose() { if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; } }
}

function driverFor(platform = process.platform) {
  if (platform === 'linux') return new LinuxDriver();
  if (platform === 'win32') return new WindowsDriver();
  return null;
}

// ------------------------------------------------------------------ the loop

function agentPrompt(goal, history, shot, step, maxSteps) {
  const past = history.length
    ? history.slice(-8).map((h, i) => `${history.length - Math.min(8, history.length) + i + 1}. ${h.label}${h.ok ? '' : ` (failed: ${h.error})`}`).join('\n')
    : 'none yet';
  return [
    `[agent] You are operating this computer to finish one task for the user. Step ${step} of at most ${maxSteps}.`,
    `Task: ${goal}`,
    `The attached screenshot is ${shot.width} x ${shot.height} pixels; give coordinates in those pixels. Open windows: ${(shot.windows || []).slice(0, 12).join('; ') || 'unknown'}.`,
    `Steps so far:\n${past}`,
    'Reply with ONE short sentence about what you will do, then exactly one action tag, for example:',
    '[[act {"type":"click","x":120,"y":340,"why":"open the File menu"}]]',
    'Actions: click (x, y, optional button right/middle, double true), type (text), key (combo like ctrl+s, enter, alt+tab), scroll (dy, positive is down, optional x y), move (x, y), open (app from the safe list), wait (ms), ask (question, when you need the user), done (summary, when the task is finished or impossible).',
    'Never enter passwords, payment details or personal data the user did not give you in the task. If the screen asks for them, use ask. No other [[tags]].',
  ].join('\n');
}

class AgentRunner {
  // deps: { screenshot(), think({ text, shot, signal }) -> reply, driver, approve(action, info) -> Promise<'yes'|'all'|'no'>,
  //         openApp(name), onStep(info), log(entry), maxSteps, settleMs, autoApprove }
  constructor(deps) {
    this.d = { maxSteps: 25, settleMs: 700, ...deps };
    this.ac = null;
    this.running = false;
  }

  stop(reason = 'stopped') { if (this.ac && !this.ac.signal.aborted) { this.reason = reason; this.ac.abort(); } }

  async run(goal) {
    if (this.running) throw new Error('The agent is already working on a task.');
    this.running = true;
    this.ac = new AbortController();
    this.reason = null;
    const signal = this.ac.signal;
    const history = [];
    let allowAll = !!this.d.autoApprove;
    const report = (o) => { try { this.d.onStep(o); } catch {} };
    try {
      for (let step = 1; step <= this.d.maxSteps; step++) {
        if (signal.aborted) return { status: 'stopped', reason: this.reason, steps: history };
        const shot = await this.d.screenshot();
        if (signal.aborted) return { status: 'stopped', reason: this.reason, steps: history };
        const reply = await this.d.think({ text: agentPrompt(goal, history, shot, step, this.d.maxSteps), shot, signal });
        if (signal.aborted) return { status: 'stopped', reason: this.reason, steps: history };
        const ex = extractAction(reply);
        const v = ex.error ? ex : validateAction(ex.raw, shot);
        if (v.error) {
          history.push({ label: `invalid action (${v.error})`, ok: false, error: v.error });
          report({ step, error: v.error });
          if (history.filter((h) => !h.ok).length >= 3) return { status: 'failed', reason: 'the brain kept giving invalid actions', steps: history };
          continue;
        }
        const a = v.action;
        const label = describe(a);
        if (a.type === 'done') { report({ step, action: a, label }); return { status: 'done', summary: a.summary, steps: history }; }
        if (a.type === 'ask') { report({ step, action: a, label }); return { status: 'ask', question: a.question, steps: history }; }
        if (!allowAll && !SAFE.has(a.type)) {
          const answer = await this.d.approve(a, { step, label, shot });
          if (signal.aborted) return { status: 'stopped', reason: this.reason, steps: history };
          if (answer === 'no') return { status: 'stopped', reason: 'you declined a step', steps: history };
          if (answer === 'all') allowAll = true;
        }
        report({ step, action: a, label, running: true });
        let ok = true;
        let error = '';
        try {
          if (a.type === 'wait') await new Promise((r) => setTimeout(r, a.ms));
          else if (a.type === 'open') await this.d.openApp(a.app);
          else {
            const p = ['click', 'move'].includes(a.type) || (a.type === 'scroll' && a.x != null) ? toScreen(a, shot) : null;
            await this.d.driver.perform(a, p);
          }
        } catch (err) { ok = false; error = err.message; }
        history.push({ label, ok, error });
        if (this.d.log) this.d.log(`agent step ${step}: ${label}${ok ? '' : ` failed: ${error}`}`);
        report({ step, action: a, label, ok, error });
        await new Promise((r) => setTimeout(r, this.d.settleMs));
      }
      return { status: 'limit', reason: `stopped after ${this.d.maxSteps} steps`, steps: history };
    } finally {
      this.running = false;
    }
  }
}

module.exports = { validateAction, extractAction, toScreen, describe, LinuxDriver, WindowsDriver, driverFor, vkCodes, agentPrompt, AgentRunner, WIN_HELPER, KEY_RE };

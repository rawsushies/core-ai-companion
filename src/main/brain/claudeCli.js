'use strict';

// Talks to Claude through the Claude Code CLI in headless mode (`claude -p`).
// It runs on the user's own Claude Code login, so COre needs no API key.
//
// Safety: COre only ever enables the read-only `Read` tool (to look at the
// screenshot it saved), runs in its own workspace folder, and uses
// `--restricted` when the installed CLI supports it so file tools stay inside
// that folder. It never passes --dangerously-skip-permissions.

const { spawn, execFile } = require('child_process');
const { randomUUID } = require('crypto');
const { persona, forWindowsShell } = require('./persona');

const IS_WIN = process.platform === 'win32';
const TURN_TIMEOUT_MS = 240_000;

function parseClaudeLine(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'stream_event') {
    const e = ev.event;
    if (e && e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
      return { kind: 'delta', text: e.delta.text || '' };
    }
    if (e && e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use') {
      return { kind: 'tool', name: e.content_block.name };
    }
    return null;
  }
  if (ev.type === 'system' && ev.subtype === 'init') {
    return { kind: 'init', sessionId: ev.session_id, model: ev.model };
  }
  if (ev.type === 'result') {
    const ok = !ev.is_error && (ev.subtype === undefined || ev.subtype === 'success');
    return {
      kind: 'result',
      ok,
      text: typeof ev.result === 'string' ? ev.result : '',
      sessionId: ev.session_id,
      error: ok ? null : (ev.result || ev.subtype || 'Claude returned an error'),
    };
  }
  return null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20_000, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// On Windows `claude` can be a native .exe (native installer) or a .cmd shim
// (npm install). A .exe can be spawned directly; a .cmd needs the shell.
async function resolveCommand(command) {
  if (!IS_WIN) return { file: command, shell: false };
  if (/\.(exe|com)$/i.test(command)) return { file: command, shell: false };
  const { stdout } = await run('where', [command]);
  const hits = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const exe = hits.find((h) => /\.exe$/i.test(h));
  if (exe) return { file: exe, shell: false };
  return { file: hits[0] || command, shell: true };
}

function quoteForCmd(arg) {
  if (arg === '') return '""';
  if (/^[\w./:\\=,-]+$/.test(arg)) return arg;
  return `"${String(arg).replace(/"/g, '')}"`;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    child.kill('SIGTERM');
  }
}

function friendlyError(text) {
  const t = String(text || '');
  if (/ENOENT|not recognized|command not found/i.test(t)) {
    return 'Claude Code is not installed or not on PATH. Install it, then run `claude` once in a terminal and log in.';
  }
  if (/login|log in|authenticat|api key|unauthori[sz]ed|401/i.test(t)) {
    return 'Claude Code is not logged in. Open a terminal, run `claude`, and type /login.';
  }
  if (/hit your [\w -]*limit|rate.?limit|usage limit|429/i.test(t)) {
    const reset = /\b(resets? [^\n.·]+)/i.exec(t);
    const when = reset ? ` (${reset[1].trim()})` : '';
    return `Claude's usage limit is reached${when}. Add a free Gemini or Groq key in ⚙ → Brain to keep talking meanwhile.`;
  }
  if (/overloaded|529/i.test(t)) return 'Claude is overloaded right now. Try again in a minute.';
  return t.split('\n').map((s) => s.trim()).filter(Boolean).slice(-3).join(' ') || 'Claude Code failed.';
}

class ClaudeCliBrain {
  constructor({ config, workDir, state }) {
    this.cfg = config; // brain.claude section
    this.workDir = workDir;
    this.state = state; // { get(key), set(key, value) }
    this.flags = null;
    this.cmd = null;
    this.id = 'claude-cli';
  }

  get label() {
    return `Claude (${this.cfg.model || 'default'}) via Claude Code`;
  }

  async detect() {
    if (this.flags) return this.flags;
    this.cmd = await resolveCommand(this.cfg.command || 'claude');
    const { err, stdout } = await run(this.cmd.file, ['--help'], { shell: this.cmd.shell });
    if (err && !stdout) throw new Error(friendlyError(err.message));
    const flags = new Set(stdout.match(/--[a-z][a-z-]+/g) || []);
    for (const need of ['--print', '--output-format', '--resume', '--session-id']) {
      if (!flags.has(need)) throw new Error(`Your Claude Code is too old (missing ${need}). Update it with: claude update`);
    }
    this.hasAuthCommand = /^\s+auth\b/m.test(stdout);
    this.flags = flags;
    if (!this.loggedIn) {
      const st = await this.authStatus();
      if (st.known && !st.loggedIn) {
        const e = new Error('Claude Code is installed but not logged in (the Claude desktop app login does not carry over).');
        e.notLoggedIn = true;
        this.flags = null; // re-check next time
        throw e;
      }
    }
    return flags;
  }

  // { known, loggedIn } from `claude auth status --json` (older CLIs: unknown).
  async authStatus() {
    if (!this.cmd) this.cmd = await resolveCommand(this.cfg.command || 'claude');
    const { stdout } = await run(this.cmd.file, ['auth', 'status', '--json'], { shell: this.cmd.shell });
    try {
      const j = JSON.parse(stdout.slice(stdout.indexOf('{')));
      this.loggedIn = !!j.loggedIn;
      return { known: true, loggedIn: this.loggedIn };
    } catch {
      return { known: false, loggedIn: false };
    }
  }

  available() {
    return true;
  }

  get name() {
    return 'Claude';
  }

  resetConversation() {
    this.state.set('claudeSessionId', null);
    this._killProc();
  }

  dispose() {
    this.disposed = true;
    this._killProc();
  }

  _args({ sessionId, resume, tone, persistent }) {
    const f = this.flags;
    const system = persona({ canReadFiles: true, tone });
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--tools', 'Read',
      '--allowedTools', 'Read',
      '--system-prompt', this.cmd.shell ? forWindowsShell(system) : system,
    ];
    if (persistent) args.push('--input-format', 'stream-json');
    if (f.has('--include-partial-messages')) args.push('--include-partial-messages');
    if (f.has('--restricted')) args.push('--restricted');
    if (f.has('--strict-mcp-config')) args.push('--strict-mcp-config');
    if (f.has('--permission-prompts')) args.push('--permission-prompts', 'none');
    // On --resume, use the current system prompt (tone) rather than the one
    // recorded when the conversation started.
    if (f.has('--system-prompt-snapshot')) args.push('--system-prompt-snapshot', 'off');
    if (this.cfg.model) args.push('--model', this.cfg.model);
    if (this.cfg.effort && f.has('--effort')) args.push('--effort', this.cfg.effort);
    if (resume) args.push('--resume', sessionId);
    else args.push('--session-id', sessionId);
    return args;
  }

  get persistent() {
    return !!(this.flags && this.flags.has('--input-format'));
  }

  // ------------------------------------------------------------ persistent session
  // One long-running `claude -p --input-format stream-json` process: each turn
  // is a JSON line on stdin. Skipping process start-up per message makes the
  // first word arrive ~1.5 s sooner. The process is restarted (with --resume,
  // so the conversation is kept) when the tone changes, after Stop, or if it dies.

  _procKey(tone) {
    return `${tone}|${this.cfg.model}|${this.cfg.effort}`;
  }

  _killProc() {
    const p = this.proc;
    this.proc = null;
    if (p) {
      p.dead = true;
      killTree(p.child);
    }
  }

  _ensureProc(tone) {
    if (this.proc && !this.proc.dead && this.proc.key === this._procKey(tone)) return this.proc;
    this._killProc();
    const existing = this.state.get('claudeSessionId');
    const sessionId = existing || randomUUID();
    const resume = !!existing;
    const args = this._args({ sessionId, resume, tone, persistent: true });
    const child = spawn(this.cmd.file, this.cmd.shell ? args.map(quoteForCmd) : args, {
      cwd: this.workDir,
      shell: this.cmd.shell,
      windowsHide: true,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'core-companion' },
    });
    const proc = { child, key: this._procKey(tone), sessionId, resume, dead: false, turn: null, stderr: '', buf: '' };
    this.proc = proc;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      proc.buf += chunk;
      let nl;
      while ((nl = proc.buf.indexOf('\n')) !== -1) {
        const line = proc.buf.slice(0, nl).trim();
        proc.buf = proc.buf.slice(nl + 1);
        if (line) this._onLine(proc, line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      proc.stderr += c;
      if (proc.stderr.length > 8000) proc.stderr = proc.stderr.slice(-8000);
    });
    child.stdin.on('error', () => {});
    const onGone = (detail) => {
      if (this.proc === proc) this.proc = null;
      const wasDead = proc.dead;
      proc.dead = true;
      const t = proc.turn;
      proc.turn = null;
      if (t && !wasDead) {
        const msg = proc.stderr || detail;
        const err = new Error(friendlyError(msg));
        err.retryable = proc.resume && /no conversation found|session/i.test(msg);
        err.streamedAnything = t.streamed.length > 0;
        t.finish(t.reject, err);
      }
    };
    child.on('error', (err) => onGone(err.message));
    child.on('close', (code) => onGone(`claude exited with code ${code}`));
    return proc;
  }

  _onLine(proc, line) {
    const ev = parseClaudeLine(line);
    const t = proc.turn;
    if (!ev || !t) return;
    if (ev.kind === 'delta' && ev.text) {
      t.streamed += ev.text;
      t.onDelta(ev.text);
    } else if (ev.kind === 'tool' && t.onTool) {
      t.onTool(ev.name);
    } else if (ev.kind === 'result') {
      proc.turn = null;
      if (ev.ok) {
        proc.resume = true; // the session now exists on disk
        this.state.set('claudeSessionId', ev.sessionId || proc.sessionId);
        if (!t.streamed && ev.text) t.onDelta(ev.text);
        t.finish(t.resolve, { text: t.streamed || ev.text });
      } else {
        const err = new Error(friendlyError(ev.error));
        err.retryable = proc.resume && /no conversation found|session/i.test(String(ev.error));
        err.streamedAnything = t.streamed.length > 0;
        t.finish(t.reject, err);
      }
    }
  }

  // Start the process ahead of time so the first message is fast too.
  async warm(tone) {
    if (this.disposed) return;
    try {
      await this.detect();
      if (this.persistent && !this.disposed) this._ensureProc(tone || 'sarcastic');
    } catch {}
  }

  _persistentTurn({ prompt, tone, signal, onDelta, onTool }) {
    return new Promise((resolve, reject) => {
      const proc = this._ensureProc(tone);
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => {
        // A turn can't be cancelled inside the process: restart it (warm).
        if (proc.turn) proc.turn = null;
        if (this.proc === proc) this._killProc();
        const e = new Error('aborted');
        e.aborted = true;
        finish(reject, e);
        setTimeout(() => this.warm(tone), 300);
      };
      const timer = setTimeout(() => {
        if (this.proc === proc) this._killProc();
        finish(reject, new Error('Claude took too long to answer.'));
      }, TURN_TIMEOUT_MS);
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort);
      }
      proc.turn = { onDelta, onTool, resolve, reject, finish, streamed: '' };
      proc.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
    });
  }

  async ask({ prompt, tone, signal, onDelta, onTool }) {
    await this.detect();
    const existing = this.state.get('claudeSessionId');
    const turn = (args) => (this.persistent ? this._persistentTurn(args) : this._turn({
      ...args, sessionId: this.state.get('claudeSessionId') || randomUUID(), resume: !!this.state.get('claudeSessionId'),
    }));
    try {
      return await turn({ prompt, tone, signal, onDelta, onTool });
    } catch (err) {
      // A stale session id (deleted history, other machine): start fresh once.
      if (existing && err.retryable && !err.streamedAnything) {
        this.resetConversation();
        return turn({ prompt, tone, signal, onDelta, onTool });
      }
      throw err;
    }
  }

  // One process per message (older Claude Code without --input-format).
  _turn({ prompt, tone, signal, onDelta, onTool, sessionId, resume }) {
    return new Promise((resolve, reject) => {
      const args = this._args({ sessionId, resume, tone, persistent: false });
      const child = spawn(this.cmd.file, this.cmd.shell ? args.map(quoteForCmd) : args, {
        cwd: this.workDir,
        shell: this.cmd.shell,
        windowsHide: true,
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'core-companion' },
      });

      let stdoutBuf = '';
      let stderr = '';
      let streamed = '';
      let result = null;
      let settled = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => {
        killTree(child);
        const e = new Error('aborted');
        e.aborted = true;
        finish(reject, e);
      };
      const timer = setTimeout(() => {
        killTree(child);
        finish(reject, new Error('Claude took too long to answer.'));
      }, TURN_TIMEOUT_MS);
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort);
      }

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk;
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          const ev = parseClaudeLine(line);
          if (!ev) continue;
          if (ev.kind === 'delta' && ev.text) {
            streamed += ev.text;
            onDelta(ev.text);
          } else if (ev.kind === 'tool' && onTool) {
            onTool(ev.name);
          } else if (ev.kind === 'result') {
            result = ev;
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => {
        stderr += c;
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
      child.on('error', (err) => finish(reject, new Error(friendlyError(err.message))));
      child.on('close', (code) => {
        if (result && result.ok) {
          this.state.set('claudeSessionId', result.sessionId || sessionId);
          if (!streamed && result.text) onDelta(result.text);
          return finish(resolve, { text: streamed || result.text });
        }
        const detail = (result && result.error) || stderr || `claude exited with code ${code}`;
        const err = new Error(friendlyError(detail));
        err.retryable = resume && /no conversation found|session/i.test(detail);
        err.streamedAnything = streamed.length > 0;
        finish(reject, err);
      });

      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }
}

module.exports = { ClaudeCliBrain, parseClaudeLine, friendlyError, quoteForCmd };

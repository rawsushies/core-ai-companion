'use strict';

// Tools for the desktop agent beyond mouse and keyboard: commands, files and
// the web. Least privilege throughout:
//  - commands: no shell (argv only), a blocklist of destructive programs, a
//    working folder inside the allowed roots, a timeout, capped output, and an
//    environment without secrets. Each one is approved by the user unless it
//    matches an "always allow" pattern they saved;
//  - files: only inside the allowed roots, never secret files; every write,
//    move or delete is backed up first so a whole task can be rolled back;
//  - web: https only, size-capped, returned as text (and treated as untrusted).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const SECRET_RE = /(^|[\\/])(\.env(\..*)?|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|kdbx)|credentials(\.json)?|\.netrc|\.npmrc|\.pypirc)$/i;

// ------------------------------------------------------------------ commands

// Quote-aware split: `git commit -m "a b"` -> ['git','commit','-m','a b'].
function parseCommand(line) {
  const out = [];
  let cur = '';
  let q = null;
  let any = false;
  for (const ch of String(line || '')) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) { out.push(cur); cur = ''; any = false; } continue; }
    cur += ch;
  }
  if (q) return null; // unbalanced quotes
  if (cur || any) out.push(cur);
  return out;
}

const BLOCKED = new Set(['format', 'diskpart', 'mkfs', 'dd', 'shutdown', 'reboot', 'halt', 'poweroff', 'reg', 'regedit', 'bcdedit', 'cipher', 'takeown', 'icacls', 'chown', 'chmod', 'sudo', 'su', 'runas', 'doas', 'passwd', 'net', 'netsh', 'sc', 'schtasks', 'crontab', 'at', 'vssadmin', 'wmic', 'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh', 'fish', 'curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'ftp', 'telnet', 'mshta', 'rundll32', 'regsvr32', 'certutil', 'bitsadmin']);
const SHELL_META = /[|&;<>`$]|\$\(|\r|\n/;

// -> { ok, argv, reason }
function checkCommand(line) {
  const s = String(line || '').trim();
  if (!s || s.length > 400) return { ok: false, reason: 'empty or too long' };
  if (SHELL_META.test(s)) return { ok: false, reason: 'pipes, redirects, chaining and variables are not allowed (no shell)' };
  const argv = parseCommand(s);
  if (!argv || !argv.length) return { ok: false, reason: 'could not read the command' };
  const prog = argv[0].split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
  if (BLOCKED.has(prog)) return { ok: false, reason: `${prog} is not allowed` };
  if ((prog === 'rm' || prog === 'del' || prog === 'rd' || prog === 'rmdir') && argv.some((a) => /^-[a-z]*r|^\/s$/i.test(a))) return { ok: false, reason: 'recursive delete is not allowed (use the delete action, which keeps a backup)' };
  if (prog === 'git' && argv.some((a) => /^(push|reset|clean|rebase|filter-branch)$/.test(a) || a === '--force' || a === '-f')) return { ok: false, reason: 'that git operation is not allowed' };
  return { ok: true, argv, prog };
}

// An "always allow" pattern matches the program and the first arguments: "git status".
function allowed(argv, patterns = []) {
  return patterns.some((p) => {
    const pa = parseCommand(p) || [];
    return pa.length && pa.every((x, i) => argv[i] !== undefined && argv[i].toLowerCase() === x.toLowerCase());
  });
}

function scrubEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/key|token|secret|password|passwd|credential|auth|cookie|session/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// Runs argv (no shell) in cwd. -> { code, out, timedOut }
function runCommand(argv, { cwd, timeoutMs = 60000, maxOut = 8000, signal } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: scrubEnv(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { resolve({ code: -1, out: `could not start: ${err.message}` }); return; }
    const add = (d) => { if (out.length < maxOut) out += d.toString('utf8'); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve({ ...r, out: out.length > maxOut ? `${out.slice(0, maxOut)}\n…(cut)` : out }); };
    // Kill the whole process tree on timeout (Windows needs taskkill /T).
    const killTree = () => {
      try {
        if (process.platform === 'win32' && child.pid) require('child_process').execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else child.kill('SIGKILL');
      } catch {}
    };
    const timer = setTimeout(() => { killTree(); finish({ code: -1, timedOut: true }); }, timeoutMs);
    if (signal) signal.addEventListener('abort', () => { killTree(); finish({ code: -1, aborted: true }); }, { once: true });
    child.on('error', (err) => { out += `could not start: ${err.message}`; finish({ code: -1 }); });
    child.on('close', (code) => finish({ code }));
  });
}

// ------------------------------------------------------------------ files

class FileOps {
  // roots: allowed folders; backupDir: where changed files are copied first.
  constructor({ roots = [], backupDir }) {
    this.roots = roots.filter(Boolean).map(safeReal).filter(Boolean);
    this.backupDir = backupDir;
  }

  // Absolute, inside a root, not a secret. Existing paths are resolved through symlinks.
  resolve(p, { mustExist = false } = {}) {
    if (!this.roots.length) throw new Error('No folder is shared with the agent (Settings → Projects).');
    const raw = String(p || '').trim();
    if (!raw) throw new Error('No path given.');
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(this.roots[0], raw);
    let real = abs;
    if (fs.existsSync(abs)) real = safeReal(abs);
    else {
      if (mustExist) throw new Error(`${raw} does not exist.`);
      // Resolve the nearest folder that exists (through symlinks), keep the rest.
      let base = path.dirname(abs);
      const rest = [path.basename(abs)];
      while (!fs.existsSync(base) && path.dirname(base) !== base) { rest.unshift(path.basename(base)); base = path.dirname(base); }
      const parent = safeReal(base);
      if (!parent) throw new Error(`The folder for ${raw} does not exist.`);
      real = path.join(parent, ...rest);
    }
    const inside = this.roots.some((r) => real === r || real.startsWith(r + path.sep));
    if (!inside) throw new Error(`${raw} is outside the folders the agent may use.`);
    if (SECRET_RE.test(real)) throw new Error(`${path.basename(real)} looks like a secret file; the agent never touches those.`);
    return real;
  }

  read(p, max = 20000) {
    const f = this.resolve(p, { mustExist: true });
    const st = fs.statSync(f);
    if (st.isDirectory()) return fs.readdirSync(f, { withFileTypes: true }).slice(0, 200).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).join('\n');
    if (st.size > 2 * 1024 * 1024) throw new Error('File is larger than 2 MB.');
    const text = fs.readFileSync(f, 'utf8');
    return text.length > max ? `${text.slice(0, max)}\n…(cut)` : text;
  }

  _backup(task, f) {
    const dir = path.join(this.backupDir, task);
    fs.mkdirSync(dir, { recursive: true });
    const man = path.join(dir, 'manifest.json');
    const list = fs.existsSync(man) ? JSON.parse(fs.readFileSync(man, 'utf8')) : [];
    const entry = { path: f, existed: fs.existsSync(f), at: Date.now() };
    if (entry.existed && fs.statSync(f).isFile()) {
      entry.copy = path.join(dir, `${list.length}-${crypto.randomBytes(4).toString('hex')}`);
      fs.copyFileSync(f, entry.copy);
    }
    list.push(entry);
    // Atomic: a crash mid-write must never leave a torn manifest (undo would then be impossible).
    const tmp = `${man}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
    fs.renameSync(tmp, man);
  }

  write(task, p, text) {
    const f = this.resolve(p);
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) throw new Error(`${p} is a folder.`);
    this._backup(task, f);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.core-tmp`;
    fs.writeFileSync(tmp, String(text));
    fs.renameSync(tmp, f);
    return f;
  }

  move(task, from, to) {
    const a = this.resolve(from, { mustExist: true });
    const b = this.resolve(to);
    if (fs.existsSync(b)) throw new Error(`${to} already exists.`);
    if (fs.statSync(a).isDirectory()) throw new Error('Moving folders is not supported; move the files.');
    this._backup(task, a);
    this._backup(task, b);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    return b;
  }

  remove(task, p) {
    const f = this.resolve(p, { mustExist: true });
    if (fs.statSync(f).isDirectory()) throw new Error('Deleting folders is not supported.');
    this._backup(task, f);
    fs.unlinkSync(f);
    return f;
  }

  // Put every file a task touched back as it was, newest change first.
  rollback(task) {
    const man = path.join(this.backupDir, task, 'manifest.json');
    if (!fs.existsSync(man)) return 0;
    const list = JSON.parse(fs.readFileSync(man, 'utf8'));
    const seen = new Set();
    let n = 0;
    for (const e of list) {
      if (seen.has(e.path)) continue; // the first backup of a path is its original state
      seen.add(e.path);
      try { fs.unlinkSync(`${e.path}.core-tmp`); } catch {} // a write cut off by a crash
      if (e.existed && e.copy) { fs.mkdirSync(path.dirname(e.path), { recursive: true }); fs.copyFileSync(e.copy, e.path); n++; }
      else if (!e.existed && fs.existsSync(e.path)) { fs.unlinkSync(e.path); n++; }
    }
    fs.renameSync(man, `${man}.rolled-back`);
    return n;
  }

  changed(task) {
    const man = path.join(this.backupDir, task, 'manifest.json');
    if (!fs.existsSync(man)) return [];
    return [...new Set(JSON.parse(fs.readFileSync(man, 'utf8')).map((e) => e.path))];
  }
}

function safeReal(p) { try { return fs.realpathSync.native(p); } catch { return null; } }

// ------------------------------------------------------------------ web

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

async function fetchText(url, fetchImpl, { maxBytes = 1_500_000, maxChars = 12000 } = {}) {
  const u = new URL(String(url));
  if (u.protocol !== 'https:') throw new Error('Only https pages can be fetched.');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname) || u.hostname.endsWith('.local')) throw new Error('Local network addresses are not allowed.');
  const res = await fetchImpl(u.href, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'COre desktop companion' } });
  if (!res.ok) throw new Error(`The page answered ${res.status}.`);
  const type = res.headers.get('content-type') || '';
  if (!/text\/|json|xml/.test(type)) throw new Error(`Not a text page (${type || 'unknown type'}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  const raw = buf.subarray(0, maxBytes).toString('utf8');
  const text = /html/.test(type) ? htmlToText(raw) : raw;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(cut)` : text;
}

module.exports = { parseCommand, checkCommand, allowed, scrubEnv, runCommand, FileOps, htmlToText, fetchText, SECRET_RE, BLOCKED };

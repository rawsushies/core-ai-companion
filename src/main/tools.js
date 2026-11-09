'use strict';

// Permissioned, read-only project tools for COre's cores (Phase 4, slice 1).
//
// Rules:
//  - The user grants ONE folder (Settings → Projects). Nothing outside it is
//    reachable: every path is resolved with realpath, so "..", absolute paths
//    and symlinks pointing elsewhere are refused.
//  - Read-only. No writes, no execution, no shell: model text is only ever
//    treated as a path or a search string, validated here.
//  - Secret-looking files (.env, keys, credentials) are always refused, and
//    noisy folders (node_modules, .git…) are skipped.
//  - Hard limits on file size, results and output, so a tool can't flood the
//    model's context or the disk.
// Every call returns { ok, text, summary } or { ok: false, error }, and is
// recorded by the caller in the audit log.

const fs = require('fs');
const path = require('path');

const LIMITS = { readBytes: 200_000, listEntries: 300, findFiles: 4000, findHits: 60, outChars: 24_000, depth: 8 };
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', '.cache', 'coverage']);
const SECRET_RE = /(^|[\\/])(\.env(\..*)?|.*\.(pem|key|p12|pfx|keystore|jks|kdbx)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|.*\.secret)$/i;

class ProjectTools {
  constructor({ root, enabled = true }) {
    this.enabled = !!enabled && !!root;
    try { this.root = root ? fs.realpathSync(root) : null; } catch { this.root = null; this.enabled = false; }
  }

  // Resolve a model-supplied relative path inside the root, or throw.
  resolve(rel) {
    if (!this.enabled || !this.root) throw new Error('No project folder is shared with COre (Settings → Projects).');
    const raw = String(rel || '.').trim().replace(/^["'`]|["'`]$/g, '') || '.';
    if (raw.includes('\0')) throw new Error('Invalid path.');
    if (path.isAbsolute(raw) || /^[a-z]:/i.test(raw) || raw.startsWith('~')) throw new Error('Paths must be relative to the shared project folder.');
    const joined = path.resolve(this.root, raw);
    let real;
    try { real = fs.realpathSync(joined); } catch { throw new Error(`Not found in the project: ${raw}`); }
    const inside = real === this.root || real.startsWith(this.root + path.sep);
    if (!inside) throw new Error('That path is outside the shared project folder.');
    const relReal = path.relative(this.root, real) || '.';
    if (SECRET_RE.test(relReal)) throw new Error(`${relReal} looks like a secret (keys, credentials, .env) and is never shared.`);
    return { real, rel: relReal.split(path.sep).join('/') };
  }

  list(rel) {
    const { real, rel: r } = this.resolve(rel);
    const st = fs.statSync(real);
    if (!st.isDirectory()) throw new Error(`${r} is a file, not a folder.`);
    const entries = fs.readdirSync(real, { withFileTypes: true })
      .filter((e) => !SKIP_DIRS.has(e.name) && !SECRET_RE.test(e.name))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    const shown = entries.slice(0, LIMITS.listEntries).map((e) => {
      if (e.isDirectory()) return `${e.name}/`;
      let size = '';
      try { size = ` (${fmtSize(fs.statSync(path.join(real, e.name)).size)})`; } catch {}
      return `${e.name}${size}`;
    });
    const more = entries.length > shown.length ? `\n… and ${entries.length - shown.length} more` : '';
    return { ok: true, text: `${r}/\n${shown.join('\n')}${more}`, summary: `listed ${r}/ (${entries.length} items)` };
  }

  read(rel) {
    const { real, rel: r } = this.resolve(rel);
    const st = fs.statSync(real);
    if (st.isDirectory()) throw new Error(`${r} is a folder; list it instead.`);
    const fd = fs.openSync(real, 'r');
    let buf;
    try {
      buf = Buffer.alloc(Math.min(st.size, LIMITS.readBytes));
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally { fs.closeSync(fd); }
    if (buf.includes(0)) throw new Error(`${r} is a binary file; only text files can be read.`);
    const cut = st.size > buf.length ? `\n… (file continues: showing the first ${fmtSize(buf.length)} of ${fmtSize(st.size)})` : '';
    return { ok: true, text: clip(`${r}\n\`\`\`\n${buf.toString('utf8')}\n\`\`\`${cut}`), summary: `read ${r} (${fmtSize(st.size)})` };
  }

  find(query, rel = '.') {
    const q = String(query || '').trim();
    if (q.length < 2 || q.length > 200) throw new Error('Search for 2 to 200 characters.');
    const { real, rel: r } = this.resolve(rel);
    const needle = q.toLowerCase();
    const hits = [];
    let files = 0;
    const walk = (dir, depth) => {
      if (depth > LIMITS.depth || hits.length >= LIMITS.findHits || files >= LIMITS.findFiles) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (hits.length >= LIMITS.findHits || files >= LIMITS.findFiles) return;
        if (SKIP_DIRS.has(e.name) || SECRET_RE.test(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue; // never follow links while walking
        if (e.isDirectory()) { walk(p, depth + 1); continue; }
        if (!e.isFile()) continue;
        files++;
        const relp = path.relative(this.root, p).split(path.sep).join('/');
        if (relp.toLowerCase().includes(needle)) hits.push(`${relp} (name)`);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.size > LIMITS.readBytes) continue;
        let text;
        try { const b = fs.readFileSync(p); if (b.includes(0)) continue; text = b.toString('utf8'); } catch { continue; }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < LIMITS.findHits; i++) {
          if (lines[i].toLowerCase().includes(needle)) hits.push(`${relp}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
        }
      }
    };
    if (fs.statSync(real).isDirectory()) walk(real, 0); else throw new Error(`${r} is a file; search a folder.`);
    const text = hits.length ? hits.join('\n') : `No matches for "${q}" in ${r}/.`;
    return { ok: true, text: clip(text), summary: `searched ${r}/ for "${q.slice(0, 40)}" (${hits.length} hit${hits.length === 1 ? '' : 's'})` };
  }

  // One tool request from a brain tag: { tool: 'list'|'read'|'find', arg }.
  run(req) {
    try {
      if (req.tool === 'list') return this.list(req.arg);
      if (req.tool === 'read') return this.read(req.arg);
      if (req.tool === 'find') return this.find(req.arg);
      return { ok: false, error: `Unknown tool ${req.tool}.` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

function fmtSize(n) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

function clip(s) {
  return s.length > LIMITS.outChars ? `${s.slice(0, LIMITS.outChars)}\n… (output cut at ${LIMITS.outChars} characters)` : s;
}

module.exports = { ProjectTools, LIMITS, SECRET_RE };

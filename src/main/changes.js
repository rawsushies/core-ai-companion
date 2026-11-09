'use strict';

// Approved file changes (Phase 4, slice 2). A core proposes a whole new file
// as a fenced code block tagged with file=PATH. COre shows the user a diff
// and writes ONLY after they click Apply:
//   - same containment and secret rules as reading (tools.js), new files only
//     inside existing folders of the shared project, text only, size-capped;
//   - Apply refuses if the file changed since the proposal (hash check);
//   - the original is backed up first and the write is atomic;
//   - every applied change can be undone (only if nobody edited it since).
// No deletes, renames or execution in this slice.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ProjectTools, SECRET_RE } = require('./tools');

const MAX_BYTES = 200_000;
const MAX_PROPOSALS = 5;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ```js file=src/app.js   (also file="a b.txt", path=...)
function extractProposals(reply) {
  const out = [];
  const re = /```[^\n`]*?\b(?:file|path)=(?:"([^"\n]+)"|'([^'\n]+)'|(\S+))[^\n]*\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(String(reply || ''))) && out.length < MAX_PROPOSALS) {
    out.push({ path: (m[1] || m[2] || m[3]).trim(), content: `${m[4]}\n` });
  }
  return out;
}

// Line diff (LCS) for the preview. Returns { added, removed, lines:[{t:'+'|'-'|' ', s}] }.
function diffLines(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  if (A.length * B.length > 4_000_000) {
    return { added: B.length, removed: A.length, lines: [{ t: ' ', s: `(too large to preview: ${A.length} → ${B.length} lines)` }], big: true };
  }
  const n = A.length; const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const lines = [];
  let i = 0; let j = 0; let added = 0; let removed = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { lines.push({ t: ' ', s: A[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ t: '-', s: A[i++] }); removed++; } else { lines.push({ t: '+', s: B[j++] }); added++; }
  }
  while (i < n) { lines.push({ t: '-', s: A[i++] }); removed++; }
  while (j < m) { lines.push({ t: '+', s: B[j++] }); added++; }
  return { added, removed, lines };
}

// Only changed lines with a little context, for the chat card.
function previewLines(diff, context = 2, max = 120) {
  if (diff.big) return diff.lines;
  const keep = new Set();
  diff.lines.forEach((l, i) => { if (l.t !== ' ') for (let k = i - context; k <= i + context; k++) keep.add(k); });
  const out = [];
  let last = -2;
  diff.lines.forEach((l, i) => {
    if (!keep.has(i)) return;
    if (i > last + 1 && out.length) out.push({ t: '@', s: '…' });
    out.push(l);
    last = i;
  });
  return out.slice(0, max);
}

class ChangeManager {
  constructor({ getTools, backupDir, log }) {
    this.getTools = getTools; // () => ProjectTools for the shared folder
    this.backupDir = backupDir;
    this.log = log || (() => {});
    this.pending = new Map(); // id -> proposal
    this.applied = new Map(); // id -> applied change (for undo)
  }

  // Validate a proposal and compute its preview. Throws a user-readable error.
  prepare({ path: rel, content }, core) {
    const tools = this.getTools();
    if (!tools.enabled || !tools.root) throw new Error('No project folder is shared (Settings → Projects).');
    const raw = String(rel || '').trim();
    if (!raw || path.isAbsolute(raw) || /^[a-z]:/i.test(raw) || raw.startsWith('~') || raw.includes('\0')) throw new Error(`Invalid path: ${raw}`);
    const body = String(content);
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error(`${raw} is too large to propose (over ${MAX_BYTES / 1000} KB).`);
    if (body.includes('\0')) throw new Error(`${raw}: only text files can be written.`);
    let real; let relReal; let isNew = false; let old = '';
    try {
      ({ real, rel: relReal } = tools.resolve(raw));
      if (fs.statSync(real).isDirectory()) throw new Error(`${raw} is a folder.`);
      old = fs.readFileSync(real, 'utf8');
      if (old.includes('\0')) throw new Error(`${raw} is a binary file.`);
    } catch (err) {
      if (!/^Not found/.test(err.message)) throw err;
      // A new file: its folder must already exist inside the project.
      const parent = tools.resolve(path.dirname(raw) === '.' ? '.' : path.dirname(raw));
      if (!fs.statSync(parent.real).isDirectory()) throw new Error(`${path.dirname(raw)} is not a folder.`);
      const name = path.basename(raw);
      if (!name || name === '.' || name === '..' || /[<>:"|?*]/.test(name)) throw new Error(`Invalid file name: ${name}`);
      real = path.join(parent.real, name);
      relReal = path.relative(tools.root, real).split(path.sep).join('/');
      if (SECRET_RE.test(relReal)) throw new Error(`${relReal} looks like a secret file and can't be written.`);
      isNew = true;
    }
    if (!isNew && old === body) throw new Error(`${relReal} is already exactly like that.`);
    const diff = diffLines(isNew ? '' : old, body);
    const id = crypto.randomUUID();
    const p = { id, core, real, rel: relReal, isNew, content: body, oldHash: isNew ? null : sha(old), added: diff.added, removed: isNew ? 0 : diff.removed, preview: previewLines(diff), at: Date.now() };
    this.pending.set(id, p);
    while (this.pending.size > 30) this.pending.delete(this.pending.keys().next().value);
    return p;
  }

  reject(id) {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (p) this.log({ tool: 'write', core: p.core, arg: p.rel, ok: false, error: 'rejected by user' });
    return p || null;
  }

  // The user clicked Apply.
  apply(id) {
    const p = this.pending.get(id);
    if (!p) throw new Error('That proposal is no longer available.');
    this.pending.delete(id);
    const tools = this.getTools();
    if (!tools.enabled || !tools.root || !(p.real === tools.root || p.real.startsWith(tools.root + path.sep))) throw new Error('The project folder is no longer shared.');
    let current = null;
    try { current = fs.readFileSync(p.real, 'utf8'); } catch {}
    if (p.isNew ? current !== null : current === null || sha(current) !== p.oldHash) {
      throw new Error(`${p.rel} changed since this was proposed, so nothing was written. Ask again for a fresh proposal.`);
    }
    let backup = null;
    if (!p.isNew) {
      backup = path.join(this.backupDir, `${Date.now()}-${p.id.slice(0, 8)}`, p.rel);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, current);
    }
    const tmp = `${p.real}.core-tmp-${process.pid}`;
    fs.writeFileSync(tmp, p.content);
    fs.renameSync(tmp, p.real);
    const change = { id: p.id, core: p.core, real: p.real, rel: p.rel, isNew: p.isNew, backup, writtenHash: sha(p.content), added: p.added, removed: p.removed };
    this.applied.set(p.id, change);
    this.log({ tool: 'write', core: p.core, arg: p.rel, ok: true, added: p.added, removed: p.removed, backup });
    return change;
  }

  // Undo an applied change, only if the file is still exactly what we wrote.
  undo(id) {
    const c = this.applied.get(id);
    if (!c) throw new Error('Nothing to undo for that change.');
    let current = null;
    try { current = fs.readFileSync(c.real, 'utf8'); } catch {}
    if (current === null || sha(current) !== c.writtenHash) throw new Error(`${c.rel} was edited after the change, so it wasn't undone (the backup is kept${c.backup ? ` at ${c.backup}` : ''}).`);
    if (c.isNew) fs.rmSync(c.real);
    else {
      const tmp = `${c.real}.core-tmp-${process.pid}`;
      fs.writeFileSync(tmp, fs.readFileSync(c.backup, 'utf8'));
      fs.renameSync(tmp, c.real);
    }
    this.applied.delete(id);
    this.log({ tool: 'undo', core: c.core, arg: c.rel, ok: true });
    return c;
  }
}

module.exports = { ChangeManager, extractProposals, diffLines, previewLines, ProjectTools };

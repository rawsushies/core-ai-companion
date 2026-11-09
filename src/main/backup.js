'use strict';

// Backups of what makes COre yours: settings, memories, notes, reminders and
// chat state, and plugin files. One JSON bundle per backup, written to any
// folder: a local one, or a folder your cloud app syncs (OneDrive, Google
// Drive, Dropbox, iCloud Drive). COre never talks to a cloud service itself.
//
// Never in a backup: API keys and other secrets (they are encrypted with this
// PC's account and useless elsewhere anyway), the calendar feed link, the
// notification token, paired phones' keys. Optionally the whole bundle is encrypted with a
// passphrase (AES-256-GCM, key from scrypt), which is wise for cloud folders.
//
// Restoring first saves a snapshot of the current files, then replaces them;
// the secrets already on this PC are kept.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAT = 'core-backup';
const VERSION = 1;
const FILES = ['config.json', 'state.json', 'memory.json', 'notes.json'];
const PLUGIN_DIR = 'skills';
const NAME_RE = /^COre-backup-(\d{4}-\d{2}-\d{2}_\d{6})(?:-([a-z-]+))?\.json$/;
const MAX_FILE = 5 * 1024 * 1024;

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// The config without anything secret.
function scrubConfig(text) {
  const c = JSON.parse(text);
  if (c.brain) {
    c.brain.secrets = {};
    if (c.brain.openaiCompat) c.brain.openaiCompat.apiKey = '';
  }
  if (c.skills) c.skills.calendarUrl = '';
  if (c.notify) c.notify.token = '';
  if (c.backup) c.backup.passphrase = '';
  return JSON.stringify(c, null, 2);
}

// State without device keys (phone pairing keys stay on this PC).
function scrubState(text) {
  const st = JSON.parse(text);
  delete st.phoneDevices;
  return JSON.stringify(st);
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

// Read what will go into a backup: { name: text }.
function collect(dataDir) {
  const files = {};
  for (const f of FILES) {
    const p = path.join(dataDir, f);
    let text;
    try {
      if (fs.statSync(p).size > MAX_FILE) continue;
      text = fs.readFileSync(p, 'utf8');
    } catch { continue; }
    if (f === 'config.json') {
      try { text = scrubConfig(text); } catch { continue; } // a damaged config is not worth keeping
    }
    if (f === 'state.json') {
      try { text = scrubState(text); } catch { continue; }
    }
    files[f] = text;
  }
  let plugins = [];
  try { plugins = fs.readdirSync(path.join(dataDir, PLUGIN_DIR)).filter((f) => /^[\w.-]+\.json$/.test(f)).slice(0, 50); } catch {}
  for (const f of plugins) {
    try {
      const p = path.join(dataDir, PLUGIN_DIR, f);
      if (fs.statSync(p).size <= 256 * 1024) files[`${PLUGIN_DIR}/${f}`] = fs.readFileSync(p, 'utf8');
    } catch {}
  }
  return files;
}

function seal(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(passphrase), salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(payload, 'utf8'), c.final()]);
  return { kdf: 'scrypt-N32768-r8-p1', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function unseal(enc, passphrase) {
  const key = crypto.scryptSync(String(passphrase), Buffer.from(enc.salt, 'base64'), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
  d.setAuthTag(Buffer.from(enc.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc.data, 'base64')), d.final()]).toString('utf8');
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Write a backup bundle. Returns { file, count, encrypted }.
function createBackup({ dataDir, destDir, passphrase = '', label = '', appVersion = '', now = new Date(), keep = 10 }) {
  if (!destDir) throw new Error('Choose a backup folder first.');
  const files = collect(dataDir);
  if (!Object.keys(files).length) throw new Error('There is nothing to back up yet.');
  const inner = JSON.stringify({ files });
  const bundle = { format: FORMAT, version: VERSION, app: appVersion, created: now.toISOString(), count: Object.keys(files).length, sha256: sha256(inner) };
  if (passphrase) bundle.enc = seal(inner, passphrase);
  else bundle.files = files;
  const name = `COre-backup-${stamp(now)}${label ? `-${label.replace(/[^a-z-]/g, '')}` : ''}.json`;
  const file = path.join(destDir, name);
  writeAtomic(file, JSON.stringify(bundle));
  if (keep > 0) prune(destDir, keep);
  return { file, count: bundle.count, encrypted: !!passphrase };
}

// Newest first: [{ file, name, created, label, size }]
function listBackups(destDir) {
  let names = [];
  try { names = fs.readdirSync(destDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    let size = 0;
    try { size = fs.statSync(path.join(destDir, name)).size; } catch { continue; }
    out.push({ file: path.join(destDir, name), name, stamp: m[1], label: m[2] || '', size });
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

// Keep the newest `keep` regular backups (labelled ones, like pre-restore, are kept apart).
function prune(destDir, keep) {
  const regular = listBackups(destDir).filter((b) => !b.label);
  for (const b of regular.slice(keep)) { try { fs.unlinkSync(b.file); } catch {} }
}

// Open and check a bundle. Returns { created, app, files }.
function readBackup(file, passphrase = '') {
  const raw = fs.readFileSync(file, 'utf8');
  let b;
  try { b = JSON.parse(raw); } catch { throw new Error('This is not a COre backup (not JSON).'); }
  if (!b || b.format !== FORMAT) throw new Error('This is not a COre backup.');
  if (b.version > VERSION) throw new Error('This backup is from a newer COre. Update COre first.');
  let inner;
  if (b.enc) {
    if (!passphrase) { const e = new Error('This backup is encrypted. Enter its passphrase.'); e.code = 'NEED_PASSPHRASE'; throw e; }
    try { inner = unseal(b.enc, passphrase); } catch { const e = new Error('Wrong passphrase, or the backup is damaged.'); e.code = 'BAD_PASSPHRASE'; throw e; }
  } else inner = JSON.stringify({ files: b.files || {} });
  if (b.sha256 && sha256(inner) !== b.sha256) throw new Error('This backup is damaged (checksum mismatch).');
  const files = JSON.parse(inner).files || {};
  for (const k of Object.keys(files)) {
    if (!(FILES.includes(k) || new RegExp(`^${PLUGIN_DIR}/[\\w.-]+\\.json$`).test(k)) || typeof files[k] !== 'string') delete files[k];
  }
  return { created: b.created, app: b.app, files };
}

// Replace the current files with a backup's. The current ones are saved first
// (into snapshotDir) and this PC's secrets are kept. Returns the restored names.
function restoreBackup({ dataDir, backup, snapshotDir, appVersion = '', now = new Date() }) {
  const files = backup.files || {};
  if (!Object.keys(files).length) throw new Error('This backup has no files.');
  for (const [k, text] of Object.entries(files)) {
    try { JSON.parse(text); } catch { throw new Error(`${k} in this backup is damaged; nothing was restored.`); }
  }
  let snapshot = null;
  try { snapshot = createBackup({ dataDir, destDir: snapshotDir, label: 'pre-restore', appVersion, now, keep: 0 }).file; } catch {}
  const restored = [];
  for (const [k, text] of Object.entries(files)) {
    let out = text;
    if (k === 'config.json') {
      // Keep this PC's secrets and token: the backup never has them.
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')); } catch {}
      const next = JSON.parse(text);
      next.brain = next.brain || {};
      next.brain.secrets = (cur.brain && cur.brain.secrets) || {};
      if (next.brain.openaiCompat && cur.brain && cur.brain.openaiCompat) next.brain.openaiCompat.apiKey = cur.brain.openaiCompat.apiKey || '';
      next.notify = next.notify || {};
      next.notify.token = (cur.notify && cur.notify.token) || '';
      if (next.skills) next.skills.calendarUrl = (cur.skills && cur.skills.calendarUrl) || '';
      out = JSON.stringify(next, null, 2);
    }
    if (k === 'state.json') {
      // Paired phones belong to this PC: keep them.
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')); } catch {}
      const next = JSON.parse(text);
      delete next.phoneDevices;
      if (cur.phoneDevices) next.phoneDevices = cur.phoneDevices;
      out = JSON.stringify(next);
    }
    writeAtomic(path.join(dataDir, ...k.split('/')), out);
    restored.push(k);
  }
  return { restored, snapshot };
}

// Folders that cloud apps keep in sync, if they exist on this PC.
function cloudFolders({ home, platform = process.platform, env = process.env, exists = fs.existsSync }) {
  const c = [];
  const add = (name, dir) => { if (dir && exists(dir) && !c.some((x) => x.dir === dir)) c.push({ name, dir, suggested: path.join(dir, 'COre Backups') }); };
  add('OneDrive', env.OneDriveConsumer);
  add('OneDrive', env.OneDrive);
  add('OneDrive', env.OneDriveCommercial);
  add('OneDrive', path.join(home, 'OneDrive'));
  add('Google Drive', path.join(home, 'Google Drive'));
  add('Google Drive', path.join(home, 'My Drive'));
  if (platform === 'win32') add('Google Drive', 'G:\\My Drive');
  if (platform === 'darwin') {
    add('iCloud Drive', path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
    try {
      const cs = path.join(home, 'Library', 'CloudStorage');
      for (const d of fs.readdirSync(cs)) {
        if (/^GoogleDrive/i.test(d)) add('Google Drive', path.join(cs, d, 'My Drive'));
        if (/^OneDrive/i.test(d)) add('OneDrive', path.join(cs, d));
        if (/^Dropbox/i.test(d)) add('Dropbox', path.join(cs, d));
      }
    } catch {}
  }
  add('Dropbox', path.join(home, 'Dropbox'));
  return c;
}

// Is an automatic backup due? (interval in hours; 0 = never)
function isDue(lastIso, hours, now = Date.now()) {
  if (!hours || hours <= 0) return false;
  const last = Date.parse(lastIso || '') || 0;
  return now - last >= hours * 3600e3;
}

module.exports = { createBackup, listBackups, readBackup, restoreBackup, cloudFolders, isDue, scrubConfig, collect, FILES };

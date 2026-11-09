'use strict';

// Self-updater for a COre install that runs from source (the unzipped folder).
//
// Source of updates: a GitHub repository (config.update.source = "owner/repo",
// branch config.update.branch). COre compares the "version" in the repo's
// package.json with its own; when the repo is newer it
//   - runs `git pull --ff-only` if the install folder is a git clone, or
//   - downloads the branch zip from codeload.github.com, extracts it, and
//     copies the new files over the app (node_modules, .git and user data are
//     never touched; user settings live in the OS app-data folder anyway),
//   - runs `npm install` only if dependencies changed,
//   - then asks to restart.
// Only HTTPS requests to github.com hosts are made, and only for the
// configured repository.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// boot.js is the stable bootstrap that rescues failed updates: never replaced.
const SKIP = new Set(['node_modules', '.git', 'dist', '.github', 'boot.js']);
// What an update replaces, and therefore what a backup must hold to undo it.
const BACKUP_ITEMS = ['src', 'assets', 'package.json', 'package-lock.json'];
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(remote, local) {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function depsChanged(oldPkg, newPkg) {
  const pick = (p) => JSON.stringify({ d: p.dependencies || {}, dd: p.devDependencies || {} });
  return pick(oldPkg) !== pick(newPkg);
}

// Copy src over dst, skipping SKIP entries. Returns the number of files written.
function copyTree(src, dst) {
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      n += copyTree(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
      n++;
    }
  }
  return n;
}

// Remove files under `dir` (relative paths within managed folders) that no
// longer exist in the new version, so deleted modules don't linger.
function pruneTree(newRoot, appRoot, rel = 'src') {
  const a = path.join(appRoot, rel);
  const b = path.join(newRoot, rel);
  if (!fs.existsSync(a) || !fs.existsSync(b)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(a, { withFileTypes: true })) {
    const relPath = path.join(rel, entry.name);
    const there = path.join(newRoot, relPath);
    if (!fs.existsSync(there)) {
      fs.rmSync(path.join(appRoot, relPath), { recursive: true, force: true });
      n++;
    } else if (entry.isDirectory()) {
      n += pruneTree(newRoot, appRoot, relPath);
    }
  }
  return n;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')} failed: ${String(stderr || err.message).trim().slice(-400)}`));
      else resolve(String(stdout));
    });
  });
}

async function extractZip(zipFile, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === 'win32') return run('tar', ['-xf', zipFile, '-C', dest]); // bsdtar ships with Windows 10+
  if (process.platform === 'darwin') return run('ditto', ['-x', '-k', zipFile, dest]);
  return run('unzip', ['-q', '-o', zipFile, '-d', dest]);
}

class Updater {
  // backupDir: where the previous version is kept while an update is applied
  // and verified (outside the app folder, e.g. userData/update-backup).
  constructor({ appRoot, getConfig, log, fetchImpl, backupDir }) {
    this.appRoot = appRoot;
    this.backupDir = backupDir || path.join(os.tmpdir(), 'core-update-backup');
    this.getConfig = getConfig; // () => config.update
    this.log = log || (() => {});
    this.fetch = fetchImpl || fetch;
    this.busy = false;
    this.timer = null;
  }

  localVersion() {
    return JSON.parse(fs.readFileSync(path.join(this.appRoot, 'package.json'), 'utf8')).version;
  }

  _source() {
    const c = this.getConfig() || {};
    const repo = String(c.source || '').trim();
    const branch = String(c.branch || 'main').trim();
    // 'release' (default): only published GitHub releases. 'main': the latest
    // development code on the branch (for developers; skips release gates).
    const channel = c.channel === 'main' ? 'main' : 'release';
    if (!repo) return null;
    if (!REPO_RE.test(repo) || !BRANCH_RE.test(branch)) throw new Error(`update.source must look like "owner/repo" (got "${repo}")`);
    return { repo, branch, channel };
  }

  // The newest available version: { version, ref, label } or null.
  async latest(src) {
    if (src.channel === 'release') {
      const res = await this.fetch(`https://api.github.com/repos/${src.repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
      if (res.status === 404) return null; // no published release yet
      if (!res.ok) throw new Error(`could not read the latest release of ${src.repo} (HTTP ${res.status})`);
      const r = await res.json();
      if (!r || r.draft || r.prerelease || !parseVersion(r.tag_name) || !/^v?\d+\.\d+\.\d+$/.test(r.tag_name)) return null;
      return { version: String(r.tag_name).replace(/^v/, ''), ref: `refs/tags/${r.tag_name}`, label: r.tag_name, tag: r.tag_name };
    }
    const raw = `https://raw.githubusercontent.com/${src.repo}/${src.branch}/package.json`;
    const res = await this.fetch(raw, { headers: { 'cache-control': 'no-cache' } });
    if (res.status === 404) throw new Error(`${src.repo} has no ${src.branch} branch with a package.json yet (is COre published there?)`);
    if (!res.ok) throw new Error(`could not read ${src.repo}@${src.branch} (HTTP ${res.status})`);
    const pkg = await res.json();
    return { version: pkg.version, ref: `refs/heads/${src.branch}`, label: `${src.branch} (v${pkg.version})` };
  }

  // Copy what an update would replace into backupDir/v<version>.
  backup(version) {
    const dir = path.join(this.backupDir, `v${String(version).replace(/[^0-9A-Za-z.-]/g, '')}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const item of BACKUP_ITEMS) {
      const from = path.join(this.appRoot, item);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, item), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, '.complete'), String(Date.now())); // only complete backups may be restored
    return dir;
  }

  // Put a backup back exactly (removes files the failed update added).
  restore(dir) {
    if (!dir || !fs.existsSync(path.join(dir, '.complete'))) throw new Error('no complete backup to restore');
    for (const item of BACKUP_ITEMS) {
      const from = path.join(dir, item);
      if (!fs.existsSync(from)) continue;
      const to = path.join(this.appRoot, item);
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true });
    }
  }

  start(onUpdated) {
    const c = this.getConfig() || {};
    if (c.enabled === false) return;
    const hours = Math.max(1, Number(c.checkHours) || 6);
    // Background checks stay silent on failure (offline, repo not published
    // yet...); only a manual "Check updates" reports problems.
    const tick = () => this.check({ onUpdated, quiet: true }).catch((err) => console.warn(`[core] update check failed: ${err.message}`));
    setTimeout(tick, 20_000); // shortly after start
    this.timer = setInterval(tick, hours * 3600_000);
  }

  stop() {
    clearInterval(this.timer);
  }

  // Returns { status: 'disabled'|'current'|'updated', version? }.
  async check({ onUpdated, quiet = false } = {}) {
    if (this.busy) return { status: 'busy' };
    const src = this._source();
    if (!src) {
      if (!quiet) this.log('Updates are not configured yet: set update.source to the GitHub repo that hosts COre.');
      return { status: 'disabled' };
    }
    this.busy = true;
    try {
      const target = await this.latest(src);
      const local = this.localVersion();
      if (!target || !isNewer(target.version, local)) {
        if (!quiet) this.log(target ? `COre is up to date (v${local}).` : `COre is up to date (v${local}); no published release is newer.`);
        return { status: 'current', version: local };
      }
      this.log(`Updating COre v${local} → v${target.version}…`);
      const oldPkg = JSON.parse(fs.readFileSync(path.join(this.appRoot, 'package.json'), 'utf8'));
      let backup = null;

      if (fs.existsSync(path.join(this.appRoot, '.git'))) {
        // A git checkout: git is the safety net (fast-forward only, nothing overwritten).
        if (target.tag) {
          await run('git', ['fetch', '--quiet', 'origin', 'tag', target.tag, '--no-tags'], { cwd: this.appRoot });
          await run('git', ['merge', '--ff-only', target.tag], { cwd: this.appRoot });
        } else {
          await run('git', ['pull', '--ff-only'], { cwd: this.appRoot });
        }
      } else {
        backup = this.backup(local);
        try {
          await this._applyZip(src, target);
        } catch (err) {
          try { this.restore(backup); } catch (e) { throw new Error(`${err.message}; restoring v${local} also failed: ${e.message}`); }
          throw new Error(`${err.message} (kept v${local})`);
        }
      }

      const newPkg = JSON.parse(fs.readFileSync(path.join(this.appRoot, 'package.json'), 'utf8'));
      // Packages are installed after the restart, before any model loads:
      // on Windows the running app keeps native modules locked (EBUSY).
      const needsInstall = depsChanged(oldPkg, newPkg);
      this.log(`COre updated to v${newPkg.version}. Restarting…`);
      if (onUpdated) onUpdated(newPkg.version, needsInstall, null, { backup, from: local });
      return { status: 'updated', version: newPkg.version, needsInstall, backup, from: local };
    } finally {
      this.busy = false;
    }
  }

  async installDependencies() {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await run(npm, ['install', '--no-audit', '--no-fund'], { cwd: this.appRoot, shell: process.platform === 'win32' });
  }

  async _applyZip(src, target) {
    const url = `https://codeload.github.com/${src.repo}/zip/${target.ref}`;
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-update-'));
    try {
      const zip = path.join(tmp, 'update.zip');
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      const out = path.join(tmp, 'x');
      await extractZip(zip, out);
      const top = fs.readdirSync(out).map((d) => path.join(out, d)).find((d) => fs.existsSync(path.join(d, 'package.json')));
      if (!top) throw new Error('the downloaded update has no package.json');
      const pkg = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8'));
      if (pkg.name !== 'core-companion') throw new Error(`refusing update: package is "${pkg.name}", not core-companion`);
      if (target.tag && pkg.version !== target.version) throw new Error(`refusing update: ${target.tag} contains version ${pkg.version}`);
      pruneTree(top, this.appRoot, 'src');
      copyTree(top, this.appRoot);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

module.exports = { Updater, isNewer, parseVersion, depsChanged, copyTree, pruneTree, BACKUP_ITEMS };

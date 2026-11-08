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

const SKIP = new Set(['node_modules', '.git', 'dist', '.github']);
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
  constructor({ appRoot, getConfig, log, fetchImpl }) {
    this.appRoot = appRoot;
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
    if (!repo) return null;
    if (!REPO_RE.test(repo) || !BRANCH_RE.test(branch)) throw new Error(`update.source must look like "owner/repo" (got "${repo}")`);
    return { repo, branch };
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
      const raw = `https://raw.githubusercontent.com/${src.repo}/${src.branch}/package.json`;
      const res = await this.fetch(raw, { headers: { 'cache-control': 'no-cache' } });
      if (res.status === 404) throw new Error(`${src.repo} has no ${src.branch} branch with a package.json yet (is COre published there?)`);
      if (!res.ok) throw new Error(`could not read ${src.repo}@${src.branch} (HTTP ${res.status})`);
      const remotePkg = await res.json();
      const local = this.localVersion();
      if (!isNewer(remotePkg.version, local)) {
        if (!quiet) this.log(`COre is up to date (v${local}).`);
        return { status: 'current', version: local };
      }
      this.log(`Updating COre v${local} → v${remotePkg.version}…`);
      const oldPkg = JSON.parse(fs.readFileSync(path.join(this.appRoot, 'package.json'), 'utf8'));

      if (fs.existsSync(path.join(this.appRoot, '.git'))) {
        await run('git', ['pull', '--ff-only'], { cwd: this.appRoot });
      } else {
        await this._applyZip(src);
      }

      const newPkg = JSON.parse(fs.readFileSync(path.join(this.appRoot, 'package.json'), 'utf8'));
      // Packages are installed after the restart, before any model loads:
      // on Windows the running app keeps native modules locked (EBUSY).
      const needsInstall = depsChanged(oldPkg, newPkg);
      this.log(`COre updated to v${newPkg.version}. Restarting…`);
      if (onUpdated) onUpdated(newPkg.version, needsInstall);
      return { status: 'updated', version: newPkg.version, needsInstall };
    } finally {
      this.busy = false;
    }
  }

  async installDependencies() {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await run(npm, ['install', '--no-audit', '--no-fund'], { cwd: this.appRoot, shell: process.platform === 'win32' });
  }

  async _applyZip(src) {
    const url = `https://codeload.github.com/${src.repo}/zip/refs/heads/${src.branch}`;
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
      pruneTree(top, this.appRoot, 'src');
      copyTree(top, this.appRoot);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

module.exports = { Updater, isNewer, parseVersion, depsChanged, copyTree, pruneTree };

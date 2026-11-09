'use strict';

// Stable bootstrap. Source updates never replace this file (see updater.js
// SKIP), so it can rescue an update whose main process won't even load: if
// loading COre throws while an update is being verified, it restores the
// backup of the previous version and restarts. Keep it tiny and dependency-free.

const fs = require('fs');
const path = require('path');
const { app, dialog } = require('electron');

const ITEMS = ['src', 'assets', 'package.json', 'package-lock.json'];

function rescue(err) {
  let statePath;
  let state;
  try {
    statePath = path.join(app.getPath('userData'), 'state.json');
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    state = null;
  }
  const uv = state && state.updateVerify;
  if (!app.isPackaged && uv && uv.backup && fs.existsSync(path.join(uv.backup, '.complete'))) {
    try {
      const deps = (dir) => { try { const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); return JSON.stringify([p.dependencies, p.devDependencies]); } catch { return ''; } };
      const depsDiffer = deps(__dirname) !== deps(uv.backup);
      for (const item of ITEMS) {
        const from = path.join(uv.backup, item);
        if (!fs.existsSync(from)) continue;
        const to = path.join(__dirname, item);
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(from, to, { recursive: true });
      }
      state.updateVerify = null;
      state.updateRolledBack = { from: uv.version, to: uv.from };
      if (depsDiffer) state.pendingInstall = true; // packages changed with the failed update
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      try {
        const logs = path.join(app.getPath('userData'), 'logs');
        fs.mkdirSync(logs, { recursive: true });
        fs.appendFileSync(path.join(logs, 'crash.log'), `${JSON.stringify({ at: new Date().toISOString(), kind: 'update-rollback', detail: `v${uv.version} failed to load: ${String(err && err.stack || err).slice(0, 2000)}` })}\n`);
      } catch {}
      app.relaunch();
      app.exit(0);
      return;
    } catch (restoreErr) {
      err = new Error(`${err && err.message}\n\nRestoring the previous version also failed: ${restoreErr.message}`);
    }
  }
  try {
    app.whenReady().then(() => {
      dialog.showErrorBox('COre could not start', String(err && err.stack || err).slice(0, 3000));
      app.exit(1);
    });
  } catch {
    process.exit(1);
  }
}

try {
  require('./src/main/main.js');
} catch (err) {
  console.error('[core] failed to load:', err);
  rescue(err);
}

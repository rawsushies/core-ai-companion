'use strict';

// Updates for installed copies (the Windows installer): GitHub Releases via
// electron-updater. Same surface as the source Updater: start(onUpdated),
// check({ quiet, onUpdated }), stop().

class ReleaseUpdater {
  constructor({ getConfig, log, autoUpdater }) {
    this.getConfig = getConfig;
    this.log = log;
    this.au = autoUpdater || require('electron-updater').autoUpdater;
    this.au.autoDownload = true;
    this.au.autoInstallOnAppQuit = true;
    this.au.logger = null;
    this.timer = null;
    this.onUpdated = null;
    this.au.on('update-downloaded', (info) => {
      if (this.onUpdated) this.onUpdated(info && info.version, false, () => this.au.quitAndInstall(true, true));
    });
  }

  async check({ quiet, onUpdated } = {}) {
    if (onUpdated) this.onUpdated = onUpdated;
    const c = this.getConfig() || {};
    if (c.enabled === false && quiet) return;
    try {
      const r = await this.au.checkForUpdates();
      const next = r && r.updateInfo && r.updateInfo.version;
      if (!quiet) this.log(next && r.isUpdateAvailable !== false && next !== this.au.currentVersion.version
        ? `Downloading COre ${next}…`
        : 'COre is up to date.');
    } catch (err) {
      if (!quiet) throw err;
      console.warn(`[core] release update check failed: ${err.message}`);
    }
  }

  start(onUpdated) {
    this.onUpdated = onUpdated;
    const c = this.getConfig() || {};
    if (c.enabled === false) return;
    const hours = Math.max(1, Number(c.checkHours) || 6);
    const tick = () => this.check({ quiet: true });
    setTimeout(tick, 20_000);
    this.timer = setInterval(tick, hours * 3600_000);
  }

  stop() { clearInterval(this.timer); }
}

module.exports = { ReleaseUpdater };

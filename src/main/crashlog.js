'use strict';

// Local crash reporting: problems are written to COre's own data folder
// (logs/crash.log, one JSON object per line) and never sent anywhere. "Copy
// diagnostics" includes the most recent ones so you can share them yourself.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 256 * 1024;

class CrashLog {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'crash.log');
  }

  record(kind, detail) {
    const entry = { at: new Date().toISOString(), kind: String(kind), detail: String(detail && detail.stack ? detail.stack : detail || '').slice(0, 4000) };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      try {
        if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
      } catch {}
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    } catch {}
    return entry;
  }

  recent(n = 5) {
    try {
      return fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-n).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }
}

module.exports = { CrashLog };

'use strict';

// Semantic vectors for memory search, from a worker thread. If the model can't
// be loaded (offline first run, blocked download) every call resolves to null
// and memory falls back to keyword + fuzzy search.
const path = require('path');
const { Worker } = require('worker_threads');

class Embedder {
  constructor({ cacheDir, model } = {}) {
    this.cacheDir = cacheDir;
    this.model = model;
    this.worker = null;
    this.failed = null;
    this.pending = new Map();
    this.next = 1;
  }

  _ensure() {
    if (this.worker || this.failed) return this.worker;
    const w = new Worker(path.join(__dirname, 'worker.mjs'), { workerData: { cacheDir: this.cacheDir, model: this.model } });
    w.on('message', ({ id, vecs, error }) => {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (error) { this.failed = error; p(null); } else p(vecs.map((v) => Float32Array.from(v)));
    });
    w.on('error', (err) => { this.failed = err.message; for (const p of this.pending.values()) p(null); this.pending.clear(); this.worker = null; });
    this.worker = w;
    return w;
  }

  embed(texts) {
    if (this.failed || !texts.length) return Promise.resolve(null);
    const w = this._ensure();
    if (!w) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = this.next++;
      this.pending.set(id, resolve);
      w.postMessage({ id, texts: texts.map((t) => String(t).slice(0, 1000)) });
      setTimeout(() => { if (this.pending.delete(id)) resolve(null); }, 120000).unref();
    });
  }

  dispose() { if (this.worker) { this.worker.terminate().catch(() => {}); this.worker = null; } }
}

module.exports = { Embedder };

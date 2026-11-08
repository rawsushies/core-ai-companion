'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

class SpeechToText {
  constructor({ model, language, cacheDir, onProgress }) {
    this.opts = { model, language, cacheDir };
    this.onProgress = onProgress || (() => {});
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  _ensure() {
    if (this.worker) return this.worker;
    const w = new Worker(path.join(__dirname, 'worker.mjs'), { workerData: this.opts });
    w.on('message', (m) => {
      if (m.type === 'progress') return this.onProgress(m);
      if (m.type === 'ready') return;
      const p = this.pending.get(m.id);
      if (m.type === 'error' && m.id === null) {
        // warm-up failed: fail everything waiting
        for (const q of this.pending.values()) q.reject(new Error(m.message));
        this.pending.clear();
        return;
      }
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'result') p.resolve(m.text);
      else p.reject(new Error(m.message));
    });
    w.on('error', (err) => {
      for (const q of this.pending.values()) q.reject(err);
      this.pending.clear();
      this.worker = null;
    });
    w.on('exit', () => { this.worker = null; });
    this.worker = w;
    return w;
  }

  warm() {
    this._ensure().postMessage({ type: 'warm' });
  }

  transcribe(float32) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._ensure().postMessage({ type: 'transcribe', id, audio: float32 }, [float32.buffer]);
    });
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }
}

module.exports = { SpeechToText };

'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

class SpeechToText {
  // fastModel: an English-only quick recognizer (Moonshine) used when fast is true
  // (English speakers); anything else uses model (Whisper, every language).
  constructor({ model, language, cacheDir, onProgress, fastModel = '', fast = false }) {
    this.opts = { model, language, cacheDir, fastModel, fast: !!(fast && fastModel) };
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

  // { fast } overrides the default (opts.fast) for one clip, e.g. to retry with Whisper.
  transcribe(float32, { fast = this.opts.fast } = {}) {
    const seconds = float32.length / 16000;
    const run = (useFast, audio) => new Promise((resolve, reject) => {
      const n = this.nextId++;
      this.pending.set(n, { resolve, reject });
      this._ensure().postMessage({ type: 'transcribe', id: n, audio, fast: useFast }, [audio.buffer]);
    });
    if (!fast) return run(false, float32);
    // Safety net: real speech (over 1.2 s) that the English recognizer turns into
    // nothing is probably another language: redo it with Whisper and stop using
    // the fast path for this session.
    const copy = new Float32Array(float32);
    return run(true, float32).then((text) => {
      if (text || seconds < 1.2) return text;
      this.opts.fast = false;
      return run(false, copy);
    });
  }

  // Resolves once the worker thread has fully stopped.
  dispose() {
    const w = this.worker;
    this.worker = null;
    return w ? w.terminate().catch(() => {}) : Promise.resolve();
  }
}

module.exports = { SpeechToText };

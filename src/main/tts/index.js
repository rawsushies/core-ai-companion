'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

// Voice tone: a pitch shift in semitones. The overlay plays audio slower by
// `rate` (lower pitch); asking Kokoro to speak faster by the same factor keeps
// the tempo natural.
function pitchRate(semitones) {
  return Math.pow(2, (Number(semitones) || 0) / 12);
}

class TextToSpeech {
  constructor({ cacheDir, onProgress, quality = 'fast' }) {
    this.cacheDir = cacheDir;
    this.quality = quality;
    this.onProgress = onProgress || (() => {});
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.failed = null; // message once loading failed, so callers fall back fast
    this.ready = false; // model loaded; until then COre uses the system voice
    this.chain = Promise.resolve(); // one sentence at a time, in order
    // Short phrases ("Paused.", "Next one.") are kept, so saying them again is
    // instant. Bounded by entries and by total samples (about 12 MB).
    this.cache = new Map();
    this.cacheSamples = 0;
    this.busy = 0;
  }

  static cacheKey(text, voice, rate, speed) { return `${voice}|${rate.toFixed(3)}|${speed}|${text}`; }

  _remember(key, r) {
    const n = r.audio ? r.audio.length : 0;
    if (!n || n > 24000 * 6) return; // keep only short clips
    this.cache.set(key, r);
    this.cacheSamples += n;
    while (this.cache.size > 60 || this.cacheSamples > 3_000_000) {
      const [k, v] = this.cache.entries().next().value;
      this.cache.delete(k);
      this.cacheSamples -= v.audio.length;
    }
  }

  _ensure() {
    if (this.worker) return this.worker;
    const w = new Worker(path.join(__dirname, 'worker.mjs'), { workerData: { cacheDir: this.cacheDir, quality: this.quality } });
    w.on('message', (m) => {
      if (m.type === 'progress') return this.onProgress(m);
      if (m.type === 'ready') { this.failed = null; this.ready = true; return; }
      if (m.type === 'error' && m.id === null) {
        this.failed = m.message;
        for (const q of this.pending.values()) q.reject(new Error(m.message));
        this.pending.clear();
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'audio') { this.ready = true; p.resolve({ audio: m.audio, sampleRate: m.sampleRate }); }
      else p.reject(new Error(m.message));
    });
    w.on('error', (err) => {
      this.failed = err.message;
      for (const q of this.pending.values()) q.reject(err);
      this.pending.clear();
      this.worker = null;
    });
    w.on('exit', () => { this.worker = null; this.ready = false; });
    this.worker = w;
    return w;
  }

  warm() {
    this._ensure().postMessage({ type: 'warm' });
  }

  // Sentences render one at a time so the first one gets the whole CPU (in
  // parallel they'd all finish late).
  synth(text, { voice, semitones, speed }) {
    const rate = pitchRate(semitones);
    const sp = Math.min(2, Math.max(0.5, (speed || 1) / rate));
    const short = String(text).length <= 80;
    const key = short ? TextToSpeech.cacheKey(String(text), voice, rate, sp) : null;
    if (key && this.cache.has(key)) {
      const hit = this.cache.get(key);
      this.cache.delete(key); this.cache.set(key, hit); // most recently used last
      return Promise.resolve({ ...hit, rate, cached: true });
    }
    const job = () => new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.busy++;
      this.pending.set(id, {
        resolve: (r) => { this.busy--; if (key) this._remember(key, r); resolve({ ...r, rate }); },
        reject: (e) => { this.busy--; reject(e); },
      });
      this._ensure().postMessage({ type: 'speak', id, text, voice, speed: sp });
    });
    const result = this.chain.then(job, job);
    this.chain = result.catch(() => {});
    return result;
  }

  // Render phrases ahead of time, one by one, only while nothing else is
  // being spoken (a real sentence never waits behind this).
  prewarm(phrases, opts) {
    const list = phrases.slice();
    const step = () => {
      if (!list.length || this.failed) return;
      if (!this.ready || this.busy) { setTimeout(step, 3000).unref(); return; }
      const text = list.shift();
      this.synth(text, opts).catch(() => {}).finally(() => setTimeout(step, 400).unref());
    };
    setTimeout(step, 0).unref();
  }

  clearCache() { this.cache.clear(); this.cacheSamples = 0; }

  // Resolves once the worker thread has fully stopped.
  dispose() {
    const w = this.worker;
    this.worker = null;
    return w ? w.terminate().catch(() => {}) : Promise.resolve();
  }
}

// Keeps a turn's items (say / gesture / end) in order while sentences are
// synthesised ahead of playback. Sentence 2 renders while sentence 1 plays.
class OrderedVoicePipeline {
  constructor({ synth, forward, onError }) {
    this.synth = synth; // (text) => Promise<{audio, sampleRate, rate}> or null to skip TTS
    this.forward = forward; // (item) => void
    this.onError = onError || (() => {});
    this.queue = [];
    this.pumping = false;
    this.cancelled = false;
  }

  push(item) {
    if (this.cancelled) return;
    const entry = { item, audio: null };
    if (item.type === 'say' && this.synth) {
      entry.audio = this.synth(item.text).catch((err) => { this.onError(err); return null; });
    }
    this.queue.push(entry);
    this._pump();
  }

  cancel() {
    this.cancelled = true;
    this.queue = [];
  }

  async _pump() {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length && !this.cancelled) {
      const entry = this.queue.shift();
      let item = entry.item;
      if (entry.audio) {
        const a = await entry.audio;
        if (this.cancelled) break;
        if (a) item = { ...item, audio: a.audio, sampleRate: a.sampleRate, rate: a.rate };
      }
      this.forward(item);
    }
    this.pumping = false;
  }
}

module.exports = { TextToSpeech, OrderedVoicePipeline, pitchRate };

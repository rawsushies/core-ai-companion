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
  constructor({ cacheDir, onProgress }) {
    this.cacheDir = cacheDir;
    this.onProgress = onProgress || (() => {});
    this.worker = null;
    this.nextId = 1;
    this.pending = new Map();
    this.failed = null; // message once loading failed, so callers fall back fast
  }

  _ensure() {
    if (this.worker) return this.worker;
    const w = new Worker(path.join(__dirname, 'worker.mjs'), { workerData: { cacheDir: this.cacheDir } });
    w.on('message', (m) => {
      if (m.type === 'progress') return this.onProgress(m);
      if (m.type === 'ready') { this.failed = null; return; }
      if (m.type === 'error' && m.id === null) {
        this.failed = m.message;
        for (const q of this.pending.values()) q.reject(new Error(m.message));
        this.pending.clear();
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.type === 'audio') p.resolve({ audio: m.audio, sampleRate: m.sampleRate });
      else p.reject(new Error(m.message));
    });
    w.on('error', (err) => {
      this.failed = err.message;
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

  synth(text, { voice, semitones, speed }) {
    const id = this.nextId++;
    const rate = pitchRate(semitones);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (r) => resolve({ ...r, rate }), reject });
      this._ensure().postMessage({ type: 'speak', id, text, voice, speed: Math.min(2, Math.max(0.5, (speed || 1) / rate)) });
    });
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
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

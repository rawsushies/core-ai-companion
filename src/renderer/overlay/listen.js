// Microphone capture + a small energy VAD. The mic is opened only while COre
// is listening and closed right after. Audio is 16 kHz mono float PCM, which
// is what the local Whisper model wants.
(function (root) {
  'use strict';

  const CHUNK_MS = 100;
  const CALIB_CHUNKS = 3;
  const START_CHUNKS = 2;
  const SILENCE_CHUNKS = 6; // 600 ms of quiet ends the utterance
  const PREROLL_CHUNKS = 3;
  const NO_SPEECH_MS = 7000;
  const MAX_MS = 25000;

  const rms = (a) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / a.length);
  };

  class Listener {
    constructor(hooks) {
      this.hooks = hooks; // { onLevel(v), onAudio(Float32Array, meta), onCancel(reason) }
      this.active = false;
    }

    async start(meta) {
      if (this.active) return;
      this.active = true;
      this.meta = meta || {};
      this.chunks = [];
      this.preroll = [];
      this.calib = [];
      this.speech = false;
      this.loud = 0;
      this.quiet = 0;
      this.startedAt = performance.now();
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (!this.active) return this._close();
        this.ctx = new AudioContext({ sampleRate: 16000 });
        await this.ctx.audioWorklet.addModule('pcm-worklet.js');
        const src = this.ctx.createMediaStreamSource(this.stream);
        this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
        this.node.port.onmessage = (e) => this._chunk(e.data);
        src.connect(this.node);
        // Keep the graph pulling without making a sound.
        const mute = this.ctx.createGain();
        mute.gain.value = 0;
        this.node.connect(mute).connect(this.ctx.destination);
      } catch (err) {
        const reason = err && err.name === 'NotAllowedError' ? 'microphone permission denied' : `microphone error: ${err.message}`;
        this.cancel(reason);
      }
    }

    _chunk(block) {
      if (!this.active) return;
      const e = rms(block);
      const elapsed = performance.now() - this.startedAt;
      if (this.calib.length < CALIB_CHUNKS) {
        this.calib.push(e);
        this.preroll.push(block);
        return;
      }
      const amb = this.calib.reduce((a, b) => a + b, 0) / this.calib.length;
      const startThr = Math.max(0.012, amb * 2.5);
      const stopThr = Math.max(0.008, amb * 1.6);
      this.hooks.onLevel(Math.min(1, e / (startThr * 2)));

      if (!this.speech) {
        this.preroll.push(block);
        if (this.preroll.length > PREROLL_CHUNKS) this.preroll.shift();
        this.loud = e > startThr ? this.loud + 1 : 0;
        if (this.loud >= START_CHUNKS) {
          this.speech = true;
          this.chunks = this.preroll.slice();
          this.quiet = 0;
        } else if (elapsed > NO_SPEECH_MS) {
          this.cancel('silence');
        }
        return;
      }
      this.chunks.push(block);
      this.quiet = e < stopThr ? this.quiet + 1 : 0;
      if (this.quiet >= SILENCE_CHUNKS || elapsed > MAX_MS) this.stop();
    }

    // Finish now (second hotkey press or end of speech).
    stop() {
      if (!this.active) return;
      if (!this.speech || !this.chunks.length) return this.cancel('silence');
      const total = this.chunks.reduce((n, c) => n + c.length, 0);
      const audio = new Float32Array(total);
      let o = 0;
      for (const c of this.chunks) { audio.set(c, o); o += c.length; }
      this.active = false;
      this._close();
      this.hooks.onLevel(0);
      this.hooks.onAudio(audio, this.meta);
    }

    cancel(reason) {
      if (!this.active) return;
      this.active = false;
      this._close();
      this.hooks.onLevel(0);
      this.hooks.onCancel(reason || 'cancelled');
    }

    _close() {
      try { if (this.node) this.node.port.onmessage = null; } catch {}
      try { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); } catch {}
      try { if (this.ctx) this.ctx.close(); } catch {}
      this.stream = null;
      this.ctx = null;
      this.node = null;
    }
  }

  root.Listener = Listener;
})(window);

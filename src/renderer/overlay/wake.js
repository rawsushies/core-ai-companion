// Hands-free listening, all on this computer.
//
// While enabled the microphone stays open and a cheap energy detector looks
// for short phrases (0.4 - 3.5 s) that start after a pause. Only those are
// sent to the local Whisper model to check for "Hey COre" - ordinary
// conversation (long speech) is never transcribed. Nothing leaves the PC.
//
// The same stream powers barge-in: if you start talking while COre is
// speaking, it stops and listens. Echo cancellation keeps COre's own voice
// from triggering it.
(function (root) {
  'use strict';

  const CHUNK_MS = 100;
  const PAUSE_BEFORE = 6; // >= 600 ms of quiet before a wake phrase
  const MIN_CHUNKS = 4; // 0.4 s
  const MAX_CHUNKS = 35; // 3.5 s ("Hey COre, what time is it?" fits)
  const END_QUIET = 4; // 400 ms of quiet ends a phrase
  const PREROLL = 3;
  const BARGE_CHUNKS = 4; // 400 ms of loud speech over COre's voice

  const rms = (a) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * a[i];
    return Math.sqrt(s / a.length);
  };

  class WakeListener {
    // hooks: { onPhrase(Float32Array), onBargeIn(), canCheck() -> bool,
    //          isSpeaking() -> bool, bargeIn() -> bool }
    constructor(hooks) {
      this.hooks = hooks;
      this.on = false;
      this.paused = false;
      this.floor = 0.006; // adaptive noise floor
    }

    async start() {
      if (this.on) return;
      this.on = true;
      this._reset();
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (!this.on) return this._close();
        this.ctx = new AudioContext({ sampleRate: 16000 });
        await this.ctx.audioWorklet.addModule('pcm-worklet.js');
        const src = this.ctx.createMediaStreamSource(this.stream);
        this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
        this.node.port.onmessage = (e) => this._chunk(e.data);
        src.connect(this.node);
        const mute = this.ctx.createGain();
        mute.gain.value = 0;
        this.node.connect(mute).connect(this.ctx.destination);
      } catch (err) {
        this.on = false;
        this._close();
        console.error('wake listener:', err && err.message);
      }
    }

    stop() {
      this.on = false;
      this._close();
    }

    // Pause while COre's normal listener has the microphone.
    pause(v) {
      this.paused = !!v;
      this._reset();
    }

    _reset() {
      this.quietRun = PAUSE_BEFORE;
      this.pre = [];
      this.phrase = null;
      this.endQuiet = 0;
      this.loudOverVoice = 0;
    }

    _chunk(block) {
      if (!this.on || this.paused) return;
      const e = rms(block);
      const thr = Math.max(0.014, this.floor * 3);
      const loud = e > thr;
      // The noise floor follows quiet moments only.
      if (!loud) this.floor += (e - this.floor) * 0.05;

      // Barge-in: sustained speech while COre talks.
      if (this.hooks.isSpeaking()) {
        if (this.hooks.bargeIn() && e > thr * 1.6) {
          if (++this.loudOverVoice >= BARGE_CHUNKS) { this._reset(); this.hooks.onBargeIn(); }
        } else this.loudOverVoice = 0;
        this.phrase = null;
        this.quietRun = 0;
        return;
      }
      this.loudOverVoice = 0;

      if (!this.phrase) {
        this.pre.push(block);
        if (this.pre.length > PREROLL) this.pre.shift();
        if (loud && this.quietRun >= PAUSE_BEFORE) {
          this.phrase = this.pre.slice();
          this.endQuiet = 0;
          this.loudCount = 0;
        }
        this.quietRun = loud ? 0 : this.quietRun + 1;
        return;
      }
      this.phrase.push(block);
      this.endQuiet = loud ? 0 : this.endQuiet + 1;
      if (loud) this.loudCount++;
      const spoken = this.loudCount + 1; // the chunk that started the phrase was loud too
      if (this.phrase.length > MAX_CHUNKS + END_QUIET) {
        // Too long to be a wake phrase: ignore until the next pause.
        this.phrase = null;
        this.quietRun = 0;
        return;
      }
      if (this.endQuiet >= END_QUIET) {
        const chunks = this.phrase.slice(0, this.phrase.length - END_QUIET + 1);
        this.phrase = null;
        this.quietRun = END_QUIET;
        if (spoken >= MIN_CHUNKS && this.hooks.canCheck()) {
          const n = chunks.reduce((a, c) => a + c.length, 0);
          const audio = new Float32Array(n);
          let o = 0;
          for (const c of chunks) { audio.set(c, o); o += c.length; }
          this.hooks.onPhrase(audio);
        }
      }
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

  WakeListener.CHUNK_MS = CHUNK_MS;
  root.WakeListener = WakeListener;
})(typeof window !== 'undefined' ? window : globalThis);

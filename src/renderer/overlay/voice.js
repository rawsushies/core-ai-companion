// COre's voice: an ordered queue of sentences and gestures.
//
// Sentences normally arrive with audio already rendered by the local neural
// voice (Kokoro) in the main process. They are played through a robotic
// effects chain:
//   pitch shift (playback rate; main renders faster so tempo stays natural)
//   + a detuned doubled layer (metallic chorus)
//   + ring modulation (the classic robot "notch")
//   + a short modulated comb filter (metallic flange)
//   + soft saturation (grit) and a chest / presence EQ.
// An analyser on the output drives the orb, so it resonates with the real
// waveform. Without rendered audio it falls back to the OS voices (Web Speech
// API), and without any voice it shows captions with a simulated envelope.
(function (root) {
  'use strict';

  function softClipCurve(amount) {
    const n = 1024;
    const curve = new Float32Array(n);
    const k = 1 + amount * 30;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    return curve;
  }

  class Voice {
    constructor(cfg, hooks) {
      this.hooks = hooks; // { onSay(text), onSpeakStart(), onIdle() }
      this.q = [];
      this.running = false;
      this.speaking = false;
      this.kick = 0;
      this.amp = 0;
      this.voice = null;
      this.token = 0;
      this.ctx = null;
      this.current = null; // playing WebAudio sources
      this.moodRate = 1; // emotion: slightly faster/brighter or slower/lower speech
      this.setConfig(cfg);
      if ('speechSynthesis' in window) {
        speechSynthesis.addEventListener('voiceschanged', () => this._pickVoice());
        this._pickVoice();
      }
    }

    setConfig(cfg) {
      this.cfg = cfg || {};
      this._pickVoice();
      this._applyRobot();
    }

    get robot() {
      const r = Number(this.cfg.robot);
      return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.45;
    }

    _pickVoice() {
      if (!('speechSynthesis' in window)) return;
      const voices = speechSynthesis.getVoices();
      if (!voices.length) return;
      const want = (this.cfg.voiceName || '').toLowerCase();
      const lang = (this.cfg.lang || navigator.language || 'en').toLowerCase();
      this.voice = (want && voices.find((v) => v.name.toLowerCase().includes(want)))
        || voices.find((v) => v.lang.toLowerCase() === lang && /natural|neural|online/i.test(v.name))
        || voices.find((v) => v.lang.toLowerCase() === lang)
        || voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2)))
        || voices.find((v) => v.default)
        || voices[0];
    }

    // ------------------------------------------------------------ robot chain

    _ensureAudio() {
      if (this.ctx) return this.ctx;
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.nodes = Voice.buildChain(ctx, ctx.destination);
      this.ampBuf = new Float32Array(this.nodes.analyser.fftSize);
      this._applyRobot();
      return ctx;
    }

    // Builds the robot effects chain on any (realtime or offline) context.
    // Returns the nodes; sources connect to nodes.input.
    static buildChain(ctx, destination) {
      const input = ctx.createGain();

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 80;
      const chest = ctx.createBiquadFilter();
      chest.type = 'lowshelf';
      chest.frequency.value = 220;
      chest.gain.value = 3.5;
      const presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 2900;
      presence.Q.value = 0.9;
      input.connect(hp).connect(chest).connect(presence);

      const master = ctx.createGain();
      const dry = ctx.createGain();
      presence.connect(dry).connect(master);

      // Ring modulator: multiply the voice by a low sine.
      const ring = ctx.createGain();
      ring.gain.value = 0;
      const ringOsc = ctx.createOscillator();
      ringOsc.frequency.value = 48;
      ringOsc.connect(ring.gain);
      ringOsc.start();
      const ringMix = ctx.createGain();
      presence.connect(ring).connect(ringMix).connect(master);

      // Metallic comb / flanger.
      const delay = ctx.createDelay(0.05);
      delay.delayTime.value = 0.0045;
      const fb = ctx.createGain();
      fb.gain.value = 0.55;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.23;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.0012;
      lfo.connect(lfoDepth).connect(delay.delayTime);
      lfo.start();
      const flangeMix = ctx.createGain();
      presence.connect(delay);
      delay.connect(fb).connect(delay);
      delay.connect(flangeMix).connect(master);

      // Grit.
      const shaper = ctx.createWaveShaper();
      const gritMix = ctx.createGain();
      presence.connect(shaper).connect(gritMix).connect(master);

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 3;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      master.connect(comp).connect(analyser).connect(destination);
      return { input, dry, ringMix, flangeMix, gritMix, shaper, presence, ringOsc, analyser };
    }

    static applyRobot(n, r) {
      n.dry.gain.value = 1 - 0.35 * r;
      n.ringMix.gain.value = 0.55 * r;
      n.flangeMix.gain.value = 0.6 * r;
      n.gritMix.gain.value = 0.22 * r;
      n.shaper.curve = softClipCurve(r);
      n.presence.gain.value = 1 + 3 * r;
      n.ringOsc.frequency.value = 40 + 25 * r;
    }

    _applyRobot() {
      if (this.nodes) Voice.applyRobot(this.nodes, this.robot);
    }

    // ------------------------------------------------------------ queue

    say(text, rendered) { this._push({ kind: 'say', text, rendered }); }
    wait(ms) { this._push({ kind: 'wait', ms }); }
    action(fn) { this._push({ kind: 'action', fn }); }
    end() { this._push({ kind: 'end' }); }

    stop() {
      this.token++;
      this.q = [];
      this.running = false;
      this.speaking = false;
      if (this.current) {
        for (const s of this.current) { try { s.stop(); } catch {} }
        this.current = null;
      }
      if ('speechSynthesis' in window) speechSynthesis.cancel();
      this.hooks.onSay('');
    }

    get busy() {
      return this.running || this.q.length > 0;
    }

    _push(item) {
      this.q.push(item);
      if (!this.running) this._next();
    }

    _next() {
      const item = this.q.shift();
      if (!item) {
        this.running = false;
        this.speaking = false;
        return;
      }
      this.running = true;
      if (item.kind === 'action') {
        try { item.fn(); } catch (e) { console.error(e); }
        return this._next();
      }
      if (item.kind === 'wait') {
        const token = this.token;
        setTimeout(() => { if (token === this.token) this._next(); }, Math.max(0, item.ms));
        return;
      }
      if (item.kind === 'end') {
        this.running = false;
        this.speaking = false;
        this.hooks.onSay('');
        if (!this.q.length) this.hooks.onIdle();
        return this._next();
      }
      this._speak(item.text, item.rendered);
    }

    _speak(text, rendered) {
      const token = this.token;
      let finished = false;
      let guard = null;
      const done = () => {
        if (finished || token !== this.token) return;
        finished = true;
        clearTimeout(guard);
        this.current = null;
        this.speaking = false;
        this._next();
      };
      this.speaking = true;
      this.kick = 1;
      this.hooks.onSpeakStart();
      // Tell listeners how long this sentence will take, so text can follow it.
      const estMs = (rendered && rendered.audio && rendered.audio.length)
        ? (rendered.audio.length / (rendered.sampleRate || 24000) / ((rendered.rate || 1) * this.moodRate)) * 1000
        : (this.cfg.tts !== false && 'speechSynthesis' in window && this.voice ? text.length * 62 / (this.cfg.rate || 1) : 500 + text.length * 58);
      this.hooks.onSay(text, estMs);

      if (this.cfg.tts !== false && rendered && rendered.audio && rendered.audio.length) {
        try {
          const ctx = this._ensureAudio();
          if (ctx.state === 'suspended') ctx.resume();
          const pcm = rendered.audio instanceof Float32Array ? rendered.audio : new Float32Array(rendered.audio);
          const buf = ctx.createBuffer(1, pcm.length, rendered.sampleRate || 24000);
          buf.copyToChannel(pcm, 0);
          const rate = (rendered.rate || 1) * this.moodRate;
          const main = ctx.createBufferSource();
          main.buffer = buf;
          main.playbackRate.value = rate;
          main.connect(this.nodes.input);
          // Detuned double: a slightly lower copy that drifts against the main
          // voice, giving the hollow, layered machine timbre.
          const dbl = ctx.createBufferSource();
          dbl.buffer = buf;
          dbl.playbackRate.value = rate * 0.987;
          const dblGain = ctx.createGain();
          dblGain.gain.value = 0.4 * this.robot;
          dbl.connect(dblGain).connect(this.nodes.input);
          main.onended = done;
          const t = ctx.currentTime + 0.02;
          main.start(t);
          dbl.start(t + 0.011);
          this.current = [main, dbl];
          guard = setTimeout(done, (buf.duration / rate) * 1000 + 1500);
          return;
        } catch (e) {
          console.error('robot voice failed, using system voice', e);
        }
      }

      const useTts = this.cfg.tts !== false && 'speechSynthesis' in window && this.voice;
      if (!useTts) {
        const ms = 500 + text.length * 58;
        const iv = setInterval(() => { if (token === this.token) this.kick = 0.6 + Math.random() * 0.4; }, 170);
        setTimeout(() => { clearInterval(iv); done(); }, ms);
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      u.voice = this.voice;
      u.lang = this.voice.lang;
      u.rate = this.cfg.rate || 1;
      u.pitch = this.cfg.pitch || 1;
      u.onboundary = () => { this.kick = 0.65 + Math.random() * 0.35; };
      u.onend = done;
      u.onerror = done;
      guard = setTimeout(done, 4000 + text.length * 120);
      speechSynthesis.speak(u);
    }

    // ------------------------------------------------------------ expressions

    // Short non-verbal sounds (giggle, hum, sigh, gasp, ding, buzz, hmm),
    // synthesised and sent through the same robot chain as the voice.
    // Returns how long it lasts in ms (0 when sound is off).
    expr(name) {
      if (this.cfg.tts === false || !Voice.EXPR_MS[name]) return 0;
      let ctx;
      try { ctx = this._ensureAudio(); } catch { return 0; }
      if (ctx.state === 'suspended') ctx.resume();
      const t0 = ctx.currentTime + 0.02;
      const out = ctx.createGain();
      out.gain.value = 0.9;
      out.connect(this.nodes.input);
      const pitch = Math.pow(2, (Number(this.cfg.semitones) || -3) / 12);
      const env = (g, at, peak, a, d) => {
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(peak, at + a);
        g.gain.exponentialRampToValueAtTime(0.0001, at + a + d);
      };
      const voiced = (f0, at, dur, peak, formants = [700, 1150]) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f0, at);
        o.frequency.exponentialRampToValueAtTime(f0 * 0.82, at + dur);
        const g = ctx.createGain();
        env(g, at, peak, Math.min(0.03, dur / 3), dur);
        for (const f of formants) {
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = f;
          bp.Q.value = 6;
          o.connect(bp).connect(g);
        }
        g.connect(out);
        o.start(at);
        o.stop(at + dur + 0.05);
      };
      const noise = (at, dur, peak, from, to, type = 'bandpass') => {
        const len = Math.ceil(ctx.sampleRate * (dur + 0.05));
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.Q.value = 0.8;
        f.frequency.setValueAtTime(from, at);
        f.frequency.exponentialRampToValueAtTime(to, at + dur);
        const g = ctx.createGain();
        env(g, at, peak, dur * 0.3, dur * 0.7);
        src.connect(f).connect(g).connect(out);
        src.start(at);
        src.stop(at + dur + 0.05);
      };
      const tone = (f, at, dur, peak, type = 'sine') => {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.value = f;
        const g = ctx.createGain();
        env(g, at, peak, 0.01, dur);
        o.connect(g).connect(out);
        o.start(at);
        o.stop(at + dur + 0.05);
      };
      if (name === 'giggle') {
        for (let i = 0; i < 5; i++) voiced((300 - i * 14) * pitch * (0.97 + Math.random() * 0.06), t0 + i * 0.12, 0.085, 0.5, [800, 1250]);
      } else if (name === 'hum') {
        [0, 4, 7, 4].forEach((st, i) => voiced(150 * pitch * Math.pow(2, st / 12), t0 + i * 0.2, 0.22, 0.35, [350, 900]));
      } else if (name === 'hmm') {
        voiced(165 * pitch, t0, 0.32, 0.35, [300, 800]);
        voiced(185 * pitch, t0 + 0.34, 0.3, 0.35, [300, 800]);
      } else if (name === 'sigh') {
        noise(t0, 0.85, 0.5, 1500, 380, 'lowpass');
        voiced(120 * pitch, t0 + 0.1, 0.6, 0.12, [500, 1000]);
      } else if (name === 'gasp') {
        noise(t0, 0.28, 0.6, 900, 2600);
      } else if (name === 'ding') {
        tone(880, t0, 0.55, 0.35);
        tone(1320, t0 + 0.08, 0.5, 0.22);
      } else if (name === 'buzz') {
        tone(110, t0, 0.32, 0.25, 'square');
      }
      const ms = Voice.EXPR_MS[name];
      this.exprUntil = performance.now() + ms + 200;
      return ms;
    }

    // Speaking energy 0..1 for this frame.
    update(dt, t) {
      let target = 0;
      if (this.nodes && (this.current || performance.now() < (this.exprUntil || 0))) {
        // Real voice: follow the actual output level.
        this.nodes.analyser.getFloatTimeDomainData(this.ampBuf);
        let s = 0;
        for (let i = 0; i < this.ampBuf.length; i++) s += this.ampBuf[i] * this.ampBuf[i];
        target = Math.min(1, Math.sqrt(s / this.ampBuf.length) * 5.5);
      } else if (this.speaking) {
        this.kick *= Math.exp(-dt * 6);
        const syll = Math.abs(Math.sin(t * 13.7)) * Math.abs(Math.sin(t * 5.3 + 1.1));
        target = Math.max(0.28 + 0.32 * syll, this.kick);
      }
      const k = target > this.amp ? 22 : 7;
      this.amp += (target - this.amp) * Math.min(1, dt * k);
      return this.amp;
    }
  }

  Voice.EXPR_MS = { giggle: 650, hum: 850, hmm: 700, sigh: 900, gasp: 320, ding: 600, buzz: 360 };

  root.Voice = Voice;
})(window);

// COre's voice: an ordered queue of sentences and gestures. Sentences are
// spoken with the operating system's voices (Web Speech API, no key, offline
// on Windows/macOS). Word-boundary events drive an amplitude envelope that
// makes the orb vibrate in time with speech. When no voice is available it
// "speaks" silently with captions and a simulated envelope.
(function (root) {
  'use strict';

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
      this.setConfig(cfg);
      if ('speechSynthesis' in window) {
        speechSynthesis.addEventListener('voiceschanged', () => this._pickVoice());
        this._pickVoice();
      }
    }

    setConfig(cfg) {
      this.cfg = cfg || {};
      this._pickVoice();
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

    say(text) { this._push({ kind: 'say', text }); }
    action(fn) { this._push({ kind: 'action', fn }); }
    end() { this._push({ kind: 'end' }); }

    stop() {
      this.token++;
      this.q = [];
      this.running = false;
      this.speaking = false;
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
      if (item.kind === 'end') {
        this.running = false;
        this.speaking = false;
        this.hooks.onSay('');
        if (!this.q.length) this.hooks.onIdle();
        return this._next();
      }
      this._speak(item.text);
    }

    _speak(text) {
      const token = this.token;
      let finished = false;
      let guard = null;
      const done = () => {
        if (finished || token !== this.token) return;
        finished = true;
        clearTimeout(guard);
        this.speaking = false;
        this._next();
      };
      this.speaking = true;
      this.kick = 1;
      this.hooks.onSpeakStart();
      this.hooks.onSay(text);

      const useTts = this.cfg.tts !== false && 'speechSynthesis' in window && this.voice;
      if (!useTts) {
        // Silent mode: simulate syllables for the vibration and hold the caption.
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
      // Chrome occasionally never fires onend; never get stuck on a sentence.
      guard = setTimeout(done, 4000 + text.length * 120);
      speechSynthesis.speak(u);
    }

    // Returns the speaking energy 0..1 for this frame.
    update(dt, t) {
      this.kick *= Math.exp(-dt * 6);
      let target = 0;
      if (this.speaking) {
        const syll = Math.abs(Math.sin(t * 13.7)) * Math.abs(Math.sin(t * 5.3 + 1.1));
        target = Math.max(0.28 + 0.32 * syll, this.kick);
      }
      const k = target > this.amp ? 18 : 6;
      this.amp += (target - this.amp) * Math.min(1, dt * k);
      return this.amp;
    }
  }

  root.Voice = Voice;
})(window);

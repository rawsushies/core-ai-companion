'use strict';

const { toneKey } = require('./persona');

const path = require('path');
const { ClaudeCliBrain } = require('./claudeCli');
const { OllamaBrain, OpenAICompatBrain } = require('./httpModels');
const { SpeechPlanner } = require('./speech');

const NAMES = {
  gemini: 'Google Gemini',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  'openai-compat': 'Custom endpoint',
};

function makeProvider(id, { config, workDir, state, getKey, onModelChange }) {
  const b = config.brain;
  if (id === 'claude-cli') return new ClaudeCliBrain({ config: b.claude, workDir, state });
  if (id === 'ollama') return new OllamaBrain({ config: b.ollama, state });
  if (NAMES[id] && b[id === 'openai-compat' ? 'openaiCompat' : id]) {
    const cfg = b[id === 'openai-compat' ? 'openaiCompat' : id];
    return new OpenAICompatBrain({
      config: cfg,
      state,
      id,
      name: NAMES[id],
      getKey: () => (getKey && getKey(id)) || cfg.apiKey || '',
      onModelChange,
    });
  }
  return null;
}

// The order COre tries brains in: the primary, then the fallbacks.
function chainIds(brainCfg) {
  const fallbacks = Array.isArray(brainCfg.fallbacks)
    ? brainCfg.fallbacks
    : (brainCfg.fallback ? [brainCfg.fallback] : []);
  return [brainCfg.provider, ...fallbacks].filter((id, i, all) => id && all.indexOf(id) === i);
}

// What COre knows about the screen beyond the picture: every open window
// (including minimised ones and other monitors), and whether pointing works.
function screenContext(shot) {
  const lines = [];
  if (shot.windows && shot.windows.length) lines.push(`Open windows: ${shot.windows.join(' | ')}.`);
  if (shot.canPoint === false) lines.push('This screenshot is from another monitor, so do not use [[point]].');
  return lines.length ? ` ${lines.join(' ')}` : '';
}

function buildPrompt(provider, text, shot) {
  if (!shot) return text;
  // shot.label: an image from a file the user attached, not their screen.
  const what = shot.label || 'A screenshot of my screen';
  const ctx = shot.label ? '' : screenContext(shot);
  if (provider.id === 'claude-cli') {
    // Persistent Claude sessions get the image inline (no file-reading step).
    if (provider.persistent) return `${text}\n\n(${what} is attached, ${shot.width}x${shot.height} pixels.${ctx})`;
    const rel = path.relative(provider.workDir, shot.path).split(path.sep).join('/');
    return `${text}\n\n(${what} is saved at ./${rel}, ${shot.width}x${shot.height} pixels. Read it before answering.${ctx})`;
  }
  const canSee = (provider.id === 'ollama' && provider.cfg.visionModel) || (provider.id !== 'ollama' && provider.cfg.vision);
  if (!canSee && shot.label) return `${text}\n\n(${what} was attached, but the model you are running on cannot see images. Say so briefly if it matters.)`;
  return canSee
    ? `${text}\n\n(${what} is attached, ${shot.width}x${shot.height} pixels.${ctx})`
    : `${text}\n\n(I shared my screen, but the model you are running on cannot see images. Say so briefly if it matters.${ctx})`;
}

class Brain {
  // getKey(id) returns a stored API key; onModelChange(id, model) persists an
  // automatically chosen model.
  constructor({ config, workDir, state, getKey, onModelChange }) {
    this.ctx = { config, workDir, state, getKey, onModelChange };
    this.stats = {}; // provider id -> health counters (see health())
    this.reload(config);
  }

  reload(config) {
    this.ctx.config = config;
    this.chain = chainIds(config.brain).map((id) => makeProvider(id, this.ctx)).filter(Boolean);
    if (!this.chain.length) throw new Error(`Unknown brain provider: ${config.brain.provider}`);
  }

  get primary() { return this.chain[0]; }
  get fallback() { return this.chain[1] || null; }

  provider(id) {
    return this.chain.find((p) => p.id === id) || null;
  }

  describe() {
    const usable = this.chain.filter((p) => !p.available || p.available());
    return {
      primary: this.primary.label,
      fallback: usable.slice(1).map((p) => p.name || p.label).join(', ') || null,
    };
  }

  resetConversation() {
    for (const p of this.chain) p.resetConversation();
  }

  // onItem receives {type:'say'|'gesture'|'end', ...}; onStatus receives
  // {kind:'provider'|'tool'|'fallback', ...} for the panel.
  // typed: the message came from the chat box (normal-chat answer, only the
  // opening is spoken). onText receives the reply text as it streams.
  // context: extra blocks for the model ([Memory], [Clipboard]), appended to the message.
  // Per-provider health, for diagnostics and the brain panel.
  health() {
    return this.chain.map((p) => ({ id: p.id, name: p.name || p.label, ...((this.stats || {})[p.id] || { ok: 0, fail: 0 }) }));
  }

  _record(p, ok, info = {}) {
    this.stats = this.stats || {};
    const s = this.stats[p.id] || (this.stats[p.id] = { ok: 0, fail: 0, firstTokenMs: null, lastError: null, lastOkAt: null });
    if (ok) {
      s.ok++;
      s.lastOkAt = Date.now();
      if (info.firstTokenMs != null) s.firstTokenMs = s.firstTokenMs == null ? info.firstTokenMs : Math.round(s.firstTokenMs * 0.7 + info.firstTokenMs * 0.3);
    } else {
      s.fail++;
      s.lastError = String(info.error || '').slice(0, 300);
      s.lastErrorAt = Date.now();
    }
  }

  // onItem receives {type:'say'|'gesture'|'end', ...}; onStatus receives
  // {kind:'provider'|'tool'|'fallback', ...} for the panel.
  // typed: the message came from the chat box (normal-chat answer, only the
  // opening is spoken). onText receives the reply text as it streams.
  // context: extra blocks for the model ([Memory], [Clipboard]), appended to the message.
  // Returns { reply, provider, truncated?, error? }: when a provider fails
  // after it already started answering, the partial reply is kept (truncated).
  async ask({ text, shot, typed = false, context = '', signal, onItem, onText, onStatus = () => {} }) {
    // Providers without a key are skipped quietly instead of failing loudly.
    const providers = this.chain.filter((p) => !p.available || p.available());
    const failures = [];
    const pc = this.ctx.config.personality || {};
    const tone = toneKey(pc.tone || 'sarcastic', pc.language);
    const limits = { ...TIMEOUTS, ...((this.ctx.config.brain && this.ctx.config.brain.timeouts) || {}) };
    let lastErr;
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      const planner = new SpeechPlanner(onItem, { onText });
      let streamed = false;
      const started = Date.now();
      let firstTokenMs = null;
      // Watchdog: a provider that never starts, or stalls mid-answer, is
      // abandoned (and the next one tried if nothing was said yet).
      const wd = new AbortController();
      let stalled = null;
      const onOuterAbort = () => wd.abort();
      if (signal) { if (signal.aborted) wd.abort(); else signal.addEventListener('abort', onOuterAbort, { once: true }); }
      let timer = null;
      const arm = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => { stalled = why; wd.abort(); }, ms); };
      arm(limits.firstTokenMs, `no answer within ${Math.round(limits.firstTokenMs / 1000)} s`);
      onStatus({ kind: 'provider', label: p.label });
      try {
        if (p.detect && shot) await p.detect().catch(() => {}); // know whether images can go inline
        await p.ask({
          prompt: buildPrompt(p, `${typed ? '[typed] ' : ''}${text}${context ? `\n\n${context}` : ''}`, shot),
          tone,
          image: shot && shot.base64 ? { base64: shot.base64, mediaType: shot.mediaType || 'image/png' } : null,
          signal: wd.signal,
          onDelta: (d) => {
            if (!streamed) firstTokenMs = Date.now() - started;
            streamed = true;
            arm(limits.idleMs, `stopped answering for ${Math.round(limits.idleMs / 1000)} s`);
            planner.feed(d);
          },
          onTool: (name) => { arm(limits.idleMs, 'stalled while using a tool'); onStatus({ kind: 'tool', name }); },
        });
        clearTimeout(timer);
        if (stalled) throw new Error(stalled); // provider ignored the abort but we already gave up on it
        const reply = planner.finish();
        this._record(p, true, { firstTokenMs });
        return { reply, provider: p.label };
      } catch (err0) {
        clearTimeout(timer);
        if (signal && signal.aborted) throw Object.assign(err0 instanceof Error ? err0 : new Error('aborted'), { aborted: true });
        const err = stalled ? Object.assign(new Error(`${p.name || p.label} ${stalled}`), { timeout: true }) : err0;
        if (err.aborted && !stalled) throw err;
        lastErr = err;
        this._record(p, false, { error: err.message });
        failures.push(`${p.name || p.label}: ${err.message}`);
        if (streamed) {
          // Keep what was already said instead of throwing it away.
          const reply = planner.finish();
          return { reply, provider: p.label, truncated: true, error: err.message };
        }
        if (i === providers.length - 1) {
          planner.finish();
          const e = new Error(failures.length > 1
            ? `No brain could answer. ${failures.join(' | ')} — connect one in ⚙ → Brain.`
            : `${failures[0]} — connect another brain in ⚙ → Brain.`);
          e.failures = failures;
          throw e;
        }
        onStatus({ kind: 'fallback', from: p.name || p.label, to: providers[i + 1].name || providers[i + 1].label, reason: err.message });
      } finally {
        if (signal) signal.removeEventListener('abort', onOuterAbort);
      }
    }
    throw lastErr || new Error('No brain is connected. Open ⚙ → Brain in the chat to connect one.');
  }
}

// Watchdog limits (overridable with brain.timeouts in config.json). The first
// token can take a while (cold Claude session, a local model loading); after
// that, long silences mean the stream is dead.
const TIMEOUTS = { firstTokenMs: 90_000, idleMs: 45_000 };

module.exports = { Brain, buildPrompt, screenContext, chainIds, NAMES, TIMEOUTS };

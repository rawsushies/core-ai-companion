'use strict';

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
  const ctx = screenContext(shot);
  if (provider.id === 'claude-cli') {
    // Persistent Claude sessions get the image inline (no file-reading step).
    if (provider.persistent) return `${text}\n\n(A screenshot of my screen is attached, ${shot.width}x${shot.height} pixels.${ctx})`;
    const rel = path.relative(provider.workDir, shot.path).split(path.sep).join('/');
    return `${text}\n\n(A screenshot of my screen is saved at ./${rel}, ${shot.width}x${shot.height} pixels. Read it before answering.${ctx})`;
  }
  const canSee = (provider.id === 'ollama' && provider.cfg.visionModel) || (provider.id !== 'ollama' && provider.cfg.vision);
  return canSee
    ? `${text}\n\n(A screenshot of my screen is attached, ${shot.width}x${shot.height} pixels.${ctx})`
    : `${text}\n\n(I shared my screen, but the model you are running on cannot see images. Say so briefly if it matters.${ctx})`;
}

class Brain {
  // getKey(id) returns a stored API key; onModelChange(id, model) persists an
  // automatically chosen model.
  constructor({ config, workDir, state, getKey, onModelChange }) {
    this.ctx = { config, workDir, state, getKey, onModelChange };
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
  async ask({ text, shot, typed = false, context = '', signal, onItem, onText, onStatus = () => {} }) {
    // Providers without a key are skipped quietly instead of failing loudly.
    const providers = this.chain.filter((p) => !p.available || p.available());
    const failures = [];
    const tone = (this.ctx.config.personality && this.ctx.config.personality.tone) || 'sarcastic';
    let lastErr;
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      const planner = new SpeechPlanner(onItem, { onText });
      let streamed = false;
      onStatus({ kind: 'provider', label: p.label });
      try {
        if (p.detect && shot) await p.detect().catch(() => {}); // know whether images can go inline
        await p.ask({
          prompt: buildPrompt(p, `${typed ? '[typed] ' : ''}${text}${context ? `\n\n${context}` : ''}`, shot),
          tone,
          image: shot && shot.base64 ? { base64: shot.base64, mediaType: shot.mediaType || 'image/png' } : null,
          signal,
          onDelta: (d) => { streamed = true; planner.feed(d); },
          onTool: (name) => onStatus({ kind: 'tool', name }),
        });
        const reply = planner.finish();
        return { reply, provider: p.label };
      } catch (err) {
        if (err.aborted) throw err;
        lastErr = err;
        failures.push(`${p.name || p.label}: ${err.message}`);
        if (streamed) {
          planner.finish();
          throw err;
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
      }
    }
    throw lastErr || new Error('No brain is connected. Open ⚙ → Brain in the chat to connect one.');
  }
}

module.exports = { Brain, buildPrompt, screenContext, chainIds, NAMES };

'use strict';

const path = require('path');
const { ClaudeCliBrain } = require('./claudeCli');
const { OllamaBrain, OpenAICompatBrain } = require('./httpModels');
const { SpeechPlanner } = require('./speech');

function makeProvider(id, { config, workDir, state }) {
  const b = config.brain;
  if (id === 'claude-cli') return new ClaudeCliBrain({ config: b.claude, workDir, state });
  if (id === 'ollama') return new OllamaBrain({ config: b.ollama, state });
  if (id === 'openai-compat') return new OpenAICompatBrain({ config: b.openaiCompat, state });
  return null;
}

function buildPrompt(provider, text, shot) {
  if (!shot) return text;
  if (provider.id === 'claude-cli') {
    const rel = path.relative(provider.workDir, shot.path).split(path.sep).join('/');
    return `${text}\n\n(A screenshot of my screen is saved at ./${rel}, ${shot.width}x${shot.height} pixels. Read it before answering.)`;
  }
  const canSee = (provider.id === 'ollama' && provider.cfg.visionModel) || (provider.id === 'openai-compat' && provider.cfg.vision);
  return canSee
    ? `${text}\n\n(A screenshot of my screen is attached, ${shot.width}x${shot.height} pixels.)`
    : `${text}\n\n(I shared my screen, but the model you are running on cannot see images. Say so briefly if it matters.)`;
}

class Brain {
  constructor({ config, workDir, state }) {
    this.ctx = { config, workDir, state };
    this.reload(config);
  }

  reload(config) {
    this.ctx.config = config;
    this.primary = makeProvider(config.brain.provider, this.ctx);
    const fb = config.brain.fallback;
    this.fallback = fb && fb !== config.brain.provider ? makeProvider(fb, this.ctx) : null;
    if (!this.primary) throw new Error(`Unknown brain provider: ${config.brain.provider}`);
  }

  describe() {
    return { primary: this.primary.label, fallback: this.fallback ? this.fallback.label : null };
  }

  resetConversation() {
    this.primary.resetConversation();
    if (this.fallback) this.fallback.resetConversation();
  }

  // onItem receives {type:'say'|'gesture'|'end', ...}; onStatus receives
  // {kind:'provider'|'tool'|'fallback', ...} for the panel.
  // typed: the message came from the chat box (normal-chat answer, only the
  // opening is spoken). onText receives the reply text as it streams.
  async ask({ text, shot, typed = false, signal, onItem, onText, onStatus = () => {} }) {
    const providers = [this.primary, this.fallback].filter(Boolean);
    const tone = (this.ctx.config.personality && this.ctx.config.personality.tone) || 'sarcastic';
    let lastErr;
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      const planner = new SpeechPlanner(onItem, { onText, maxSpoken: typed ? 2 : Infinity });
      let streamed = false;
      onStatus({ kind: 'provider', label: p.label });
      try {
        await p.ask({
          prompt: buildPrompt(p, typed ? `[typed] ${text}` : text, shot),
          tone,
          image: shot && shot.base64 ? { base64: shot.base64 } : null,
          signal,
          onDelta: (d) => { streamed = true; planner.feed(d); },
          onTool: (name) => onStatus({ kind: 'tool', name }),
        });
        const reply = planner.finish();
        return { reply, provider: p.label };
      } catch (err) {
        if (err.aborted) throw err;
        lastErr = err;
        if (streamed || i === providers.length - 1) {
          planner.finish();
          throw err;
        }
        onStatus({ kind: 'fallback', from: p.label, to: providers[i + 1].label, reason: err.message });
      }
    }
    throw lastErr;
  }
}

module.exports = { Brain, buildPrompt };

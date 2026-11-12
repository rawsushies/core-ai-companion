'use strict';

// Free / cheap fallbacks:
//  - Ollama: fully local, no key, no cost (https://ollama.com).
//  - OpenAI-compatible endpoints: DeepSeek, OpenRouter free models, LM Studio...
// Both keep their own short chat history (Claude Code keeps its own session).

const { persona } = require('./persona');

const MAX_HISTORY = 24;
// Also bound history by size: pasted clipboard text and memory blocks can be
// long, and small local models have small context windows (~4k tokens).
const MAX_HISTORY_CHARS = 24_000;

// Newest messages that fit both limits, starting on a user turn.
function trimHistory(msgs, maxMsgs = MAX_HISTORY, maxChars = MAX_HISTORY_CHARS) {
  let h = msgs.slice(-maxMsgs);
  const size = (m) => (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length);
  let total = h.reduce((n, m) => n + size(m), 0);
  while (h.length && total > maxChars) total -= size(h.shift());
  while (h.length && h[0].role !== 'user') h.shift();
  return h;
}

class HistoryMixin {
  constructor(state, key) {
    this._state = state;
    this._key = key;
  }
  get history() {
    return this._state.get(this._key) || [];
  }
  push(...msgs) {
    this._state.set(this._key, trimHistory([...this.history, ...msgs]));
  }
  resetConversation() {
    this._state.set(this._key, []);
  }
}

async function* readLines(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      yield buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) yield buf.trim();
}

class OllamaBrain extends HistoryMixin {
  constructor({ config, state }) {
    super(state, 'ollamaHistory');
    this.cfg = config;
    this.id = 'ollama';
    this.name = 'Local model (Ollama)';
  }

  available() {
    return !!this.cfg.baseUrl;
  }

  // { running, hasModel, models } — quick probe for the status panel.
  async probe(timeoutMs = 1200) {
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { running: false };
      const models = ((await res.json()).models || []).map((m) => m.name);
      const want = this.cfg.model.includes(':') ? this.cfg.model : `${this.cfg.model}:latest`;
      return { running: true, models, hasModel: models.some((m) => m === this.cfg.model || m === want) };
    } catch {
      return { running: false };
    }
  }

  get label() {
    return `${this.cfg.model} via Ollama (local)`;
  }

  async ask({ prompt, image, tone, signal, onDelta, model: modelOverride }) {
    const model = image && this.cfg.visionModel ? this.cfg.visionModel : (modelOverride || this.cfg.model);
    const user = { role: 'user', content: prompt };
    if (image && this.cfg.visionModel) user.images = [image.base64];
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        stream: true,
        keep_alive: '30m', // keep the model loaded between turns instead of reloading it each time
        messages: [{ role: 'system', content: persona({ canReadFiles: false, tone }) }, ...this.history, user],
      }),
    }).catch((err) => {
      if (err.name === 'AbortError') throw Object.assign(new Error('aborted'), { aborted: true });
      throw new Error(`Ollama is not running at ${this.cfg.baseUrl}. Install it from ollama.com and run: ollama pull ${this.cfg.model}`);
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(/not found/i.test(t) ? `Ollama has no model ${model}. Run: ollama pull ${model}` : `Ollama error ${res.status}: ${t.slice(0, 200)}`);
    }
    let text = '';
    for await (const line of readLines(res.body)) {
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.error) throw new Error(`Ollama: ${ev.error}`);
      const d = ev.message && ev.message.content;
      if (d) { text += d; onDelta(d); }
    }
    this.push({ role: 'user', content: prompt }, { role: 'assistant', content: text });
    return { text };
  }
}

class OpenAICompatBrain extends HistoryMixin {
  // id: 'gemini' | 'groq' | 'openrouter' | 'openai-compat'; getKey() returns the API key.
  constructor({ config, state, id = 'openai-compat', name, getKey, onModelChange }) {
    super(state, `${id}History`);
    this.cfg = config;
    this.id = id;
    this.name = name || id;
    this.getKey = getKey || (() => config.apiKey || '');
    this.onModelChange = onModelChange || (() => {});
  }

  get label() {
    return `${this.cfg.model || 'auto'} via ${this.name}`;
  }

  available() {
    return !!this.cfg.baseUrl && (this.cfg.noKey === true || !!this.getKey());
  }

  _headers() {
    const headers = { 'content-type': 'application/json' };
    const key = this.getKey();
    if (key) headers.authorization = `Bearer ${key}`;
    return headers;
  }

  // Providers rename models over time. Ask the endpoint which models exist and
  // pick the best match for this preset's preference pattern.
  async resolveModel(signal) {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/models`, { headers: this._headers(), signal });
    if (!res.ok) return null;
    const data = await res.json();
    const ids = (data.data || data.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
    const prefer = this.cfg.prefer ? new RegExp(this.cfg.prefer, 'i') : null;
    const avoid = /embed|tts|audio|image|vision-preview|guard|whisper|moderation/i;
    const pick = ids.find((m) => (!prefer || prefer.test(m)) && !avoid.test(m)) || ids.find((m) => !avoid.test(m));
    if (pick && pick !== this.cfg.model) {
      this.cfg.model = pick;
      this.onModelChange(this.id, pick);
    }
    return pick || null;
  }

  async ask(args) {
    if (!this.cfg.model) await this.resolveModel(args.signal);
    try {
      return await this._ask(args);
    } catch (err) {
      if (err.modelProblem && !args._retried && (await this.resolveModel(args.signal))) {
        return this._ask({ ...args, _retried: true });
      }
      throw err;
    }
  }

  // effort -> reasoning_effort, only where enabled (brain.<id>.reasoningEffort)
  // and only until an endpoint rejects it.
  async _ask({ prompt, image, tone, signal, onDelta, model: modelOverride, effort }) {
    const re = effort && this.cfg.reasoningEffort && !this.noEffort ? ({ minimal: 'low', low: 'low', medium: 'medium', high: 'high' }[effort] || null) : null;
    const content = image && this.cfg.vision
      ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${image.mediaType || 'image/png'};base64,${image.base64}` } }]
      : prompt;
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      signal,
      body: JSON.stringify({
        model: modelOverride || this.cfg.model,
        ...(re ? { reasoning_effort: re } : {}),
        stream: true,
        temperature: 0.7,
        messages: [{ role: 'system', content: persona({ canReadFiles: false, tone }) }, ...this.history, { role: 'user', content }],
      }),
    }).catch((err) => {
      if (err.name === 'AbortError') throw Object.assign(new Error('aborted'), { aborted: true });
      throw new Error(`Cannot reach ${this.cfg.baseUrl}: ${err.message}`);
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) throw new Error(`${this.name} rejected the API key.`);
      if (res.status === 429) {
        const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        throw Object.assign(new Error(`${this.name} is rate limited right now (free tier limit).`), { retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) * 1000 : 0 });
      }
      if (re && res.status === 400 && /reasoning/i.test(t)) { this.noEffort = true; return this._ask({ prompt, image, tone, signal, onDelta, model: modelOverride }); }
      const err = new Error(`${this.name} error ${res.status}: ${t.slice(0, 200)}`);
      err.modelProblem = res.status === 404 || /model/i.test(t);
      throw err;
    }
    let text = '';
    for await (const line of readLines(res.body)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      const d = ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content;
      if (d) { text += d; onDelta(d); }
    }
    this.push({ role: 'user', content: prompt }, { role: 'assistant', content: text });
    return { text };
  }
}

module.exports = { OllamaBrain, OpenAICompatBrain, readLines, trimHistory };

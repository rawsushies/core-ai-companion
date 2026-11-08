'use strict';

// Free / cheap fallbacks:
//  - Ollama: fully local, no key, no cost (https://ollama.com).
//  - OpenAI-compatible endpoints: DeepSeek, OpenRouter free models, LM Studio...
// Both keep their own short chat history (Claude Code keeps its own session).

const { persona } = require('./persona');

const MAX_HISTORY = 24;

class HistoryMixin {
  constructor(state, key) {
    this._state = state;
    this._key = key;
  }
  get history() {
    return this._state.get(this._key) || [];
  }
  push(...msgs) {
    const h = [...this.history, ...msgs].slice(-MAX_HISTORY);
    this._state.set(this._key, h);
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
  }

  get label() {
    return `${this.cfg.model} via Ollama (local)`;
  }

  async ask({ prompt, image, tone, signal, onDelta }) {
    const model = image && this.cfg.visionModel ? this.cfg.visionModel : this.cfg.model;
    const user = { role: 'user', content: prompt };
    if (image && this.cfg.visionModel) user.images = [image.base64];
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        stream: true,
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
  constructor({ config, state }) {
    super(state, 'openaiHistory');
    this.cfg = config;
    this.id = 'openai-compat';
  }

  get label() {
    let host = this.cfg.baseUrl;
    try { host = new URL(this.cfg.baseUrl).host; } catch {}
    return `${this.cfg.model} via ${host}`;
  }

  async ask({ prompt, image, tone, signal, onDelta }) {
    const content = image && this.cfg.vision
      ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image.base64}` } }]
      : prompt;
    const headers = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: this.cfg.model,
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
      throw new Error(res.status === 401 ? `${this.label} rejected the API key.` : `${this.label} error ${res.status}: ${t.slice(0, 200)}`);
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

module.exports = { OllamaBrain, OpenAICompatBrain, readLines };

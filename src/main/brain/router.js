'use strict';

// Brain router: picks which provider answers each request, so COre is never
// stuck on one brain. Three ideas:
//  1. Capabilities: each provider has known strengths (vision, speed, depth,
//     local). A request states what it needs (an image? deep work?) and
//     providers that fit go first.
//  2. Health: every failure is classified (no key/login, rate limit, overload,
//     timeout, network, model) and the provider cools down for a while that
//     grows with repeated failures, so a dead brain costs nothing next turn.
//  3. Measured speed and success rate break ties; the user's chosen main brain
//     gets a bonus, not a monopoly ('auto'). 'manual' keeps the exact order
//     and only skips providers that are cooling down.

// Static strengths, 1 (weak) .. 3 (strong). Vision may be overridden by config.
// ctx: usable context window in tokens; cost: 0 free .. 3 expensive (per request,
// relative; a Claude subscription counts as cheap but has usage limits).
const CAPS = {
  'claude-cli': { depth: 3, speed: 2, vision: true, local: false, ctx: 200000, cost: 1 },
  gemini: { depth: 2.5, speed: 3, vision: true, local: false, ctx: 1000000, cost: 0 },
  groq: { depth: 2, speed: 3, vision: false, local: false, ctx: 128000, cost: 0 },
  openrouter: { depth: 1.5, speed: 1.5, vision: false, local: false, ctx: 32000, cost: 0 },
  'openai-compat': { depth: 2, speed: 2, vision: false, local: false, ctx: 64000, cost: 1 },
  ollama: { depth: 1, speed: 2, vision: false, local: true, ctx: 8000, cost: 0 },
};

// Natural-language model descriptions (Jev reads these to pick a model).
// Override per provider with brain.descriptions[id] in config.json.
const DESCRIPTIONS = {
  'claude-cli': 'Claude through Claude Code: strongest reasoning, coding and planning, sees images; slower to start and has usage limits',
  gemini: 'Google Gemini: fast, sees images, very long context; free tier has rate limits',
  groq: 'Groq: very fast text-only answers, good general knowledge; free tier rate limits',
  openrouter: 'OpenRouter free models: text only, slower and less reliable, a last resort',
  'openai-compat': 'A custom OpenAI-compatible endpoint configured by the user',
  ollama: 'A small local model: private and offline, weak at hard reasoning, short context',
};

function capsOf(p) {
  const base = { ...(CAPS[p.id] || { depth: 1.5, speed: 1.5, vision: false, local: false }) };
  const cfg = p.cfg || {};
  if (p.id === 'claude-cli') {
    const m = String(cfg.model || '').toLowerCase();
    if (/haiku/.test(m)) { base.depth = 2.5; base.speed = 2.5; }
    if (/opus/.test(m)) { base.depth = 3.2; base.speed = 1.5; }
  } else if (p.id === 'ollama') base.vision = !!cfg.visionModel;
  else if (typeof cfg.vision === 'boolean') base.vision = cfg.vision;
  if (Number(cfg.contextTokens) > 0) base.ctx = Number(cfg.contextTokens);
  if (Number.isFinite(Number(cfg.cost)) && cfg.cost !== '' && cfg.cost != null) base.cost = Number(cfg.cost);
  return base;
}

function describe(p, overrides = {}) {
  const c = capsOf(p);
  const model = p.cfg && p.cfg.model ? ` (${p.cfg.model})` : '';
  return `${overrides[p.id] || DESCRIPTIONS[p.id] || p.name || p.id}${model}. ${c.vision ? 'Can see images.' : 'Text only.'} Context about ${Math.round(c.ctx / 1000)}k tokens.`;
}

// Hard limits first (no opinion involved): a request with an image needs a
// brain that can see; a long request needs a big enough context window.
// Returns the eligible providers, or all of them when none qualify (so the
// best effort still runs and fails loudly rather than silently doing nothing).
function eligible(providers, need = {}) {
  const ok = providers.filter((p) => {
    const c = capsOf(p);
    if (need.vision && !c.vision) return false;
    if (need.tokens && c.ctx < need.tokens * 1.2) return false;
    return true;
  });
  return ok.length ? ok : providers;
}

// Which model a provider should use for this need: the strong model for deep
// work when the provider has one configured (brain.<id>.strongModel).
function modelFor(p, need = {}, routing = 'auto') {
  const cfg = p.cfg || {};
  if (routing === 'off' || need.depth !== 'strong') return cfg.model || '';
  return cfg.strongModel || cfg.model || '';
}

// -> 'auth' | 'rate' | 'overload' | 'timeout' | 'network' | 'model' | 'other'
function classify(err) {
  const m = String((err && err.message) || err || '');
  if (err && err.notLoggedIn) return 'auth';
  if (/not (installed|logged in)|rejected the API key|unauthori[sz]ed|invalid api key|\b40[13]\b|log ?in/i.test(m)) return 'auth';
  if (/usage limit|rate.?limit|\b429\b|quota|too many requests|limit is reached/i.test(m)) return 'rate';
  if (/overloaded|\b5(00|02|03|29)\b|unavailable|capacity/i.test(m)) return 'overload';
  if ((err && err.timeout) || /no answer within|stopped answering|stalled|timed? ?out/i.test(m)) return 'timeout';
  if (/cannot reach|ECONN|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket/i.test(m)) return 'network';
  if ((err && err.modelProblem) || /no model|model .*not found|unknown model/i.test(m)) return 'model';
  return 'other';
}

// Cooldown per failure kind: [first, max] in ms; doubles with each repeat.
const COOLDOWN = {
  auth: [10 * 60e3, 60 * 60e3],
  rate: [60e3, 20 * 60e3],
  overload: [30e3, 5 * 60e3],
  timeout: [45e3, 10 * 60e3],
  network: [20e3, 5 * 60e3],
  model: [0, 60e3],
  other: [15e3, 2 * 60e3],
};

class Router {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.h = {}; // id -> { ok, fail, streak, until, kind, reason, firstTokenMs, lastOkAt }
  }

  _s(id) { return this.h[id] || (this.h[id] = { ok: 0, fail: 0, streak: 0, until: 0, kind: '', reason: '', firstTokenMs: null, lastOkAt: 0 }); }

  success(id, { firstTokenMs } = {}) {
    const s = this._s(id);
    s.ok++;
    s.streak = 0;
    s.until = 0;
    s.kind = '';
    s.reason = '';
    s.lastOkAt = this.now();
    if (firstTokenMs != null) s.firstTokenMs = s.firstTokenMs == null ? firstTokenMs : Math.round(s.firstTokenMs * 0.7 + firstTokenMs * 0.3);
  }

  // retryAfterMs: when the provider said how long to wait.
  failure(id, err, { retryAfterMs = 0 } = {}) {
    const s = this._s(id);
    const kind = classify(err);
    s.fail++;
    s.streak = s.kind === kind ? s.streak + 1 : 1;
    s.kind = kind;
    s.reason = String((err && err.message) || err || '').slice(0, 200);
    const [first, max] = COOLDOWN[kind];
    const wait = Math.max(retryAfterMs, Math.min(max, first * 2 ** (s.streak - 1)));
    s.until = wait ? this.now() + wait : 0;
    return { kind, wait };
  }

  cooling(id) { const s = this.h[id]; return !!s && s.until > this.now(); }

  // A key was added or a login fixed: forget the cooldown.
  clear(id) { if (this.h[id]) { this.h[id].until = 0; this.h[id].streak = 0; this.h[id].kind = ''; } }

  // How long to wait for the first word: generous for an unknown or cold
  // provider, tighter once we know how fast it usually is (and others remain).
  firstTokenLimit(id, maxMs, othersLeft) {
    const s = this.h[id];
    if (!othersLeft || !s || s.firstTokenMs == null) return maxMs;
    return Math.max(20e3, Math.min(maxMs, s.firstTokenMs * 4));
  }

  // need: { vision?: bool, depth?: 'fast'|'strong' }. opts: { mode, preferred }
  // Returns the providers in the order to try, with a reason for the first.
  order(providers, need = {}, { mode = 'auto', preferred = null } = {}) {
    const now = this.now();
    const ready = providers.filter((p) => !this.cooling(p.id));
    // Everyone is cooling down: try the one that recovers first rather than nothing.
    const pool = ready.length ? ready : providers.slice().sort((a, b) => this._s(a.id).until - this._s(b.id).until).slice(0, 1);
    if (mode === 'manual') return pool;
    const scored = pool.map((p, i) => {
      const c = capsOf(p);
      const s = this._s(p.id);
      let score = 0;
      if (need.vision) score += c.vision ? 4 : -6;
      if (need.depth === 'strong') score += c.depth * 2 + c.speed * 0.3;
      else score += c.speed * 1.5 + c.depth * 0.8;
      if (s.ok + s.fail >= 3) score += (s.ok / (s.ok + s.fail) - 0.5) * 2;
      if (s.firstTokenMs != null && need.depth !== 'strong') score -= Math.min(2, s.firstTokenMs / 8000);
      score -= c.cost * (need.depth === 'strong' ? 0.15 : 0.4); // cheaper wins ties, more so for easy requests
      if (need.prefer === p.id) score += 5; // the decision layer picked this model
      if (p.id === preferred) score += 1.5;
      score -= i * 0.05; // stable: configured order breaks exact ties
      return { p, score };
    });
    return scored.sort((a, b) => b.score - a.score).map((x) => x.p);
  }

  status(providers) {
    const now = this.now();
    return providers.map((p) => {
      const s = this._s(p.id);
      const avail = !p.available || p.available();
      return {
        id: p.id,
        name: p.name || p.label,
        model: (p.cfg && p.cfg.model) || '',
        caps: capsOf(p),
        state: !avail ? 'no-key' : s.until > now ? (s.kind === 'auth' ? 'needs-login' : 'cooling') : 'ready',
        until: s.until > now ? s.until : 0,
        reason: s.until > now ? s.reason : '',
        ok: s.ok,
        fail: s.fail,
        firstTokenMs: s.firstTokenMs,
      };
    });
  }
}

module.exports = { Router, classify, capsOf, describe, eligible, modelFor, CAPS, COOLDOWN, DESCRIPTIONS };

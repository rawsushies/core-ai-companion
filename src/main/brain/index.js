'use strict';

const { toneKey } = require('./persona');

const path = require('path');
const { ClaudeCliBrain } = require('./claudeCli');
const { OllamaBrain, OpenAICompatBrain } = require('./httpModels');
const { SpeechPlanner } = require('./speech');
const { Router, eligible, describe: describeModel, modelFor } = require('./router');

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
  // profile: 'chat' (fast answers first) or 'strong' (deep work: the agent,
  // specialists). router: share one Router so all brains learn provider health.
  // decider: the fast decision layer (decide.js), shared across brains.
  constructor({ config, workDir, state, getKey, onModelChange, profile = 'chat', router = null, decider = null }) {
    this.ctx = { config, workDir, state, getKey, onModelChange };
    this.stats = {}; // provider id -> health counters (see health())
    this.profile = profile;
    this.router = router || new Router();
    this.decider = decider;
    this.lastRoute = null;
    // Continuity: one shared log of this conversation. Each provider remembers
    // the last entry it saw, so a model taking over gets a recap of the turns
    // it missed instead of starting blind.
    this.turns = [];
    this.seq = 0;
    this.seen = {};
    this.reload(config);
  }

  _recapFor(p) {
    const since = this.seen[p.id] || 0;
    const missed = this.turns.filter((t) => t.seq > since).slice(-10);
    if (!missed.length) return '';
    return `[Earlier in this conversation] (another model answered these turns; they are finished, so do not redo anything in them. Answer only the new message below, naturally, without mentioning the switch)\n${missed.map((t) => `${t.role === 'user' ? 'User' : 'COre'}: ${t.text.length > 600 ? `${t.text.slice(0, 600)}…` : t.text}`).join('\n')}`;
  }

  _logTurn(p, user, reply) {
    // A reply that was only actions (a [[forget]], a timer) still answered the message: without a
    // COre line the recap shows it as unanswered and the next model does it again.
    const said = String(reply || '').trim() || (user ? '(done with an action; nothing left to do)' : '');
    for (const [role, text] of [['user', user], ['core', said]]) if (text) this.turns.push({ seq: ++this.seq, role, text: String(text).slice(0, 2000) });
    if (this.turns.length > 30) this.turns.splice(0, this.turns.length - 30);
    this.seen[p.id] = this.seq;
  }

  routeStatus() { return { mode: this.mode, last: this.lastRoute, providers: this.router.status(this.chain) }; }
  get mode() { return (this.ctx.config.brain && this.ctx.config.brain.mode) === 'manual' ? 'manual' : 'auto'; }

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
    this.turns = [];
    this.seen = {};
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
  // decide: run the fast decision layer first (Prime's user turns). hasFiles:
  // the message carries attached files. Returns also { decision } when decided.
  async ask({ text, shot, typed = false, context = '', signal, onItem = () => {}, onText, onStatus = () => {}, decide = false, hasFiles = false, agentEnabled = false }) {
    const bc = this.ctx.config.brain || {};
    // Providers without a key are skipped quietly instead of failing loudly.
    const usable = this.chain.filter((p) => !p.available || p.available());
    const need = {
      vision: !!(shot && shot.base64),
      depth: this.profile === 'strong' ? 'strong' : 'fast',
      tokens: Math.round((String(text).length + String(context).length) / 4) + 2000,
    };
    // 1. Hard limits (code, not opinion): vision, context size, health.
    const pool = eligible(usable.filter((p) => !this.router.cooling(p.id)).length ? usable.filter((p) => !this.router.cooling(p.id)) : usable, need);
    // 2. Fast decision: what is this, how hard, which specialist, which model.
    let decision = null;
    if (decide && this.decider) {
      try {
        decision = await this.decider.decide(text, { hasImage: need.vision, hasFiles, agentEnabled, recent: this.turns.slice(-4), candidates: pool.map((p) => ({ id: p.id, description: describeModel(p, bc.descriptions || {}) })) });
      } catch { decision = null; }
      if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      if (decision) {
        if (this.profile !== 'strong') need.depth = decision.complexity === 'complex' || decision.effort === 'high' ? 'strong' : 'fast';
        if (decision.modelIndex >= 0 && pool[decision.modelIndex]) need.prefer = pool[decision.modelIndex].id;
        const hints = routeHints(decision, { agentEnabled });
        if (hints) context = context ? `${context}\n\n${hints}` : hints;
      }
    }
    // 3. Order: capability fit, measured health and speed, cost, preference.
    const providers = this.router.order(eligible(usable, need), need, { mode: this.mode, preferred: bc.provider });
    if (providers[0]) this.lastRoute = { provider: providers[0].name || providers[0].label, need, decision, at: Date.now() };
    const failures = [];
    const pc = this.ctx.config.personality || {};
    const tone = toneKey(pc.tone || 'sarcastic', pc.language);
    const limits = { ...TIMEOUTS, ...((this.ctx.config.brain && this.ctx.config.brain.timeouts) || {}) };
    let lastErr;
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      let acted = false; // a reply of only actions ([[forget]], a timer) is still an answer
      const planner = new SpeechPlanner((it) => { if (it && it.type !== 'say' && it.type !== 'end') acted = true; onItem(it); }, { onText });
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
      const firstLimit = this.router.firstTokenLimit(p.id, limits.firstTokenMs, i < providers.length - 1);
      arm(firstLimit, `no answer within ${Math.round(firstLimit / 1000)} s`);
      onStatus({ kind: 'provider', label: p.label });
      try {
        if (p.detect && shot) await p.detect().catch(() => {}); // know whether images can go inline
        const recap = this._recapFor(p);
        const model = modelFor(p, need, bc.routing);
        await p.ask({
          model: model && model !== (p.cfg && p.cfg.model) ? model : undefined,
          effort: decision ? decision.effort : (this.profile === 'strong' ? 'high' : undefined),
          // The recap goes first and the new message after it: placed last, the recap ends on a "COre: ..."
          // line and models carry on that transcript, answering twice (seen with Gemini after a Groq rate limit).
          prompt: buildPrompt(p, `${recap ? `${recap}\n\n[New message]\n` : ''}${typed ? '[typed] ' : ''}${text}${context ? `\n\n${context}` : ''}`, shot),
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
        // An empty answer (a reasoning model that spent its budget thinking, a filtered reply) is a
        // failure, not a silent success: the next brain gets the turn.
        if (!String(reply || '').trim() && !acted) throw Object.assign(new Error(`${p.name || p.label} gave an empty answer`), { empty: true });
        this._record(p, true, { firstTokenMs });
        this.router.success(p.id, { firstTokenMs });
        this._logTurn(p, text, reply);
        this.lastRoute = { ...(this.lastRoute || {}), provider: p.name || p.label, model: model || (p.cfg && p.cfg.model), at: Date.now() };
        return { reply, provider: p.label, decision };
      } catch (err0) {
        clearTimeout(timer);
        if (signal && signal.aborted) throw Object.assign(err0 instanceof Error ? err0 : new Error('aborted'), { aborted: true });
        const err = stalled ? Object.assign(new Error(`${p.name || p.label} ${stalled}`), { timeout: true }) : err0;
        if (err.aborted && !stalled) throw err;
        lastErr = err;
        this._record(p, false, { error: err.message });
        this.router.failure(p.id, err, { retryAfterMs: err.retryAfterMs || 0 });
        failures.push(`${p.name || p.label}: ${err.message}`);
        if (streamed && !err.empty) {
          // Keep what was already said instead of throwing it away.
          const reply = planner.finish();
          this._logTurn(p, text, reply);
          return { reply, provider: p.label, truncated: true, error: err.message, decision };
        }
        if (i === providers.length - 1) {
          planner.finish();
          // Every brain busy on its free-tier limit is not a setup problem: say so, and when to retry.
          const limited = this.chain.filter((c) => this.router.cooling(c.id));
          const allLimited = failures.every((f) => /rate limit/i.test(f)) && limited.length >= Math.min(this.chain.length, 2);
          const soonest = allLimited ? Math.min(...limited.map((c) => this.router._s(c.id).until)) - this.router.now() : 0;
          const e = new Error(allLimited
            ? `All your brains are rate limited right now (free-tier limits). Try again in ${soonest > 90e3 ? `about ${Math.ceil(soonest / 60e3)} minutes` : 'a minute'}, or add a paid key in ⚙ → Brain. Timers and the time still work.`
            : failures.length > 1
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

// A few words for the main brain about what the decision layer saw. Advice
// only: it may delegate or suggest /do, never act on its own because of this.
function routeHints(d, { agentEnabled = false } = {}) {
  const out = [];
  if (d.specialist && d.specialist !== 'none') out.push(`a specialist fits: ${d.specialist} (delegate if it helps)`);
  // A skill (open an app, music, a timer, a note) is done at once with its tag; /do is only worth
  // suggesting when the desktop agent is on and no skill covers it. With it off, never point at /do.
  if (d.actsOnSystem >= 0.6 && d.task === 'desktop') {
    out.push(agentEnabled
      ? 'this asks to act on the computer: if one of your skills does it (open, music, timer, note), use its [[do ...]] tag now; otherwise tell the user to start the desktop agent with /do and a short instruction'
      : 'this asks to act on the computer: if one of your skills does it (open, music, timer, note), use its [[do ...]] tag now; otherwise say plainly you cannot do that yet (the desktop agent is off in Settings), and never tell the user to type a command');
  }
  if (d.underspecified >= 0.6) out.push('the request is vague: ask one short clarifying question first');
  if (d.complexity === 'complex') out.push('this is complex: plan briefly, then answer step by step');
  return out.length ? `[Route] ${out.join('; ')}.` : '';
}

// Watchdog limits (overridable with brain.timeouts in config.json). The first
// token can take a while (cold Claude session, a local model loading); after
// that, long silences mean the stream is dead.
const TIMEOUTS = { firstTokenMs: 90_000, idleMs: 45_000 };

module.exports = { Brain, buildPrompt, screenContext, chainIds, routeHints, NAMES, TIMEOUTS };

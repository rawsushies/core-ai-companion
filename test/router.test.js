'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Router, classify, capsOf } = require('../src/main/brain/router');
const { Brain } = require('../src/main/brain');

test('failures are classified from real provider messages', () => {
  assert.strictEqual(classify(new Error("Claude's usage limit is reached (resets 5pm).")), 'rate');
  assert.strictEqual(classify(new Error('Groq is rate limited right now (free tier limit).')), 'rate');
  assert.strictEqual(classify(new Error('Claude Code is not logged in. Open a terminal')), 'auth');
  assert.strictEqual(classify(new Error('Gemini rejected the API key.')), 'auth');
  assert.strictEqual(classify(new Error('Claude is overloaded right now.')), 'overload');
  assert.strictEqual(classify(Object.assign(new Error('Claude no answer within 90 s'), { timeout: true })), 'timeout');
  assert.strictEqual(classify(new Error('Cannot reach http://127.0.0.1:11434: fetch failed')), 'network');
  assert.strictEqual(classify(new Error('weird')), 'other');
});

test('cooldowns grow with repeats, honour Retry-After, and clear on success or a new key', () => {
  let now = 1e6;
  const r = new Router({ now: () => now });
  assert.strictEqual(r.failure('groq', new Error('rate limited')).wait, 60e3);
  assert.ok(r.cooling('groq'));
  assert.strictEqual(r.failure('groq', new Error('rate limited')).wait, 120e3);
  assert.strictEqual(r.failure('gemini', new Error('429'), { retryAfterMs: 300e3 }).wait, 300e3);
  now += 121e3;
  assert.ok(!r.cooling('groq'));
  r.success('groq', { firstTokenMs: 800 });
  assert.strictEqual(r.failure('groq', new Error('rate limited')).wait, 60e3, 'streak reset by success');
  r.clear('groq');
  assert.ok(!r.cooling('groq'));
});

const P = (id, cfg = {}) => ({ id, name: id, cfg, available: () => true });

test('auto order: fast for chat, deep for strong work, vision when there is an image, skips resting brains', () => {
  const r = new Router();
  const list = [P('claude-cli', { model: 'haiku' }), P('gemini', { vision: true }), P('groq', { vision: false }), P('ollama', {})];
  const ids = (need, o = {}) => r.order(list, need, { preferred: 'claude-cli', ...o }).map((p) => p.id);
  assert.strictEqual(ids({ depth: 'fast' })[0], 'claude-cli', 'the preferred brain leads while healthy');
  assert.deepStrictEqual(ids({ depth: 'fast' }, { preferred: 'groq' }).slice(0, 1), ['groq']);
  assert.notStrictEqual(ids({ depth: 'fast', vision: true }, { preferred: 'groq' })[0], 'groq', 'groq cannot see images');
  assert.strictEqual(ids({ depth: 'strong' }, { preferred: 'gemini' }).at(-1), 'ollama', 'small local model last for deep work');
  r.failure('claude-cli', new Error("Claude's usage limit is reached"));
  assert.strictEqual(ids({ depth: 'fast' })[0], 'gemini', 'a rate-limited brain is skipped');
  assert.deepStrictEqual(r.order(list, {}, { mode: 'manual' }).map((p) => p.id), ['gemini', 'groq', 'ollama'], 'manual keeps the order, minus resting');
  for (const p of list) r.failure(p.id, new Error('rate limit'));
  assert.strictEqual(r.order(list, {}).length, 1, 'all resting: still try the one that recovers first');
  assert.strictEqual(capsOf(P('claude-cli', { model: 'opus' })).depth > capsOf(P('claude-cli', { model: 'haiku' })).depth, true);
});

// A Brain over scripted fake providers.
function fakeBrain(behaviours, { profile = 'chat', mode = 'auto', provider = 'claude-cli', router } = {}) {
  const config = { brain: { provider, mode, fallbacks: Object.keys(behaviours).filter((k) => k !== provider), claude: { model: 'haiku' }, gemini: { vision: true, baseUrl: 'x' }, groq: { baseUrl: 'x' } }, personality: {} };
  const b = new Brain({ config, workDir: '/tmp', state: { get() {}, set() {} }, profile, router });
  const calls = [];
  b.chain = Object.entries(behaviours).map(([id, fn]) => ({
    id, name: id, label: id, cfg: config.brain[id === 'claude-cli' ? 'claude' : id] || {}, available: () => true, resetConversation() {},
    ask: async ({ onDelta, image }) => { calls.push(id); const t = await fn({ image }); onDelta(t); return { text: t }; },
  }));
  return { b, calls };
}

test('a brain that fails is skipped on the next turn without waiting for it again', async () => {
  const router = new Router();
  const { b, calls } = fakeBrain({ 'claude-cli': async () => { throw new Error("Claude's usage limit is reached"); }, gemini: async () => 'from gemini', groq: async () => 'from groq' }, { router });
  const statuses = [];
  const r1 = await b.ask({ text: 'hi', onStatus: (s) => statuses.push(s) });
  assert.strictEqual(r1.reply, 'from gemini');
  assert.ok(statuses.some((s) => s.kind === 'fallback'));
  const r2 = await b.ask({ text: 'again' });
  assert.match(r2.reply, /from (gemini|groq)/);
  assert.deepStrictEqual(calls.filter((c) => c === 'claude-cli').length, 1, 'Claude was not retried while resting');
  assert.strictEqual(b.routeStatus().providers.find((p) => p.id === 'claude-cli').state, 'cooling');
});

test('an image goes to a brain that can see; the shared router teaches every brain at once', async () => {
  const router = new Router();
  const { b, calls } = fakeBrain({ groq: async () => 'groq', gemini: async ({ image }) => (image ? 'gemini saw it' : 'gemini') }, { provider: 'groq', router });
  const r = await b.ask({ text: 'what is this', shot: { base64: 'AAAA', width: 1, height: 1, label: 'An image' } });
  assert.strictEqual(r.reply, 'gemini saw it');
  assert.deepStrictEqual(calls, ['gemini']);
  router.failure('groq', new Error('rate limited'));
  const other = fakeBrain({ groq: async () => 'groq', gemini: async () => 'gemini' }, { provider: 'groq', router });
  assert.strictEqual((await other.b.ask({ text: 'hello' })).reply, 'gemini', 'another brain sharing the router skips groq too');
});

test('Claude steps down from the strong model to the fast one when the strong one hits its limit', async () => {
  const { ClaudeCliBrain } = require('../src/main/brain/claudeCli');
  const c = new ClaudeCliBrain({ config: { model: 'sonnet', fallbackModel: 'haiku' }, workDir: '/tmp', state: { get() {}, set() {} } });
  c.detect = async () => new Set();
  c.flags = new Set();
  const models = [];
  c._turn = async () => { models.push(c.cfg.model); if (c.cfg.model === 'sonnet') throw new Error("Claude's usage limit is reached (resets 5pm)."); return { text: 'ok' }; };
  assert.deepStrictEqual(await c.ask({ prompt: 'x', onDelta() {} }), { text: 'ok' });
  assert.deepStrictEqual(models, ['sonnet', 'haiku']);
  c._turn = async () => { throw new Error("Claude's usage limit is reached"); };
  await assert.rejects(c.ask({ prompt: 'x', onDelta() {} }), /usage limit/, 'no loop once already on the fast model');
});

test('reasoning effort: Claude runs deep turns once with --effort high; HTTP providers get reasoning_effort until they reject it', async () => {
  const { ClaudeCliBrain } = require('../src/main/brain/claudeCli');
  const c = new ClaudeCliBrain({ config: { model: 'haiku' }, workDir: '/tmp', state: { get() {}, set() {} } });
  c.detect = async () => {};
  c.flags = new Set(['--effort', '--input-format']);
  c.cmd = { file: 'claude', shell: false };
  const seen = [];
  c._turn = async () => { seen.push(c._args({ sessionId: 's', resume: false, tone: 'calm', persistent: false, model: c._oneShotModel || undefined, effort: c._oneShotEffort || undefined })); return { text: 'ok' }; };
  c._persistentTurn = async () => { seen.push('persistent'); return { text: 'ok' }; };
  c._killProc = () => {};
  await c.ask({ prompt: 'x', onDelta() {}, effort: 'high' });
  await c.ask({ prompt: 'x', onDelta() {}, effort: 'low' });
  const a = seen[0];
  assert.strictEqual(a[a.indexOf('--effort') + 1], 'high');
  assert.strictEqual(seen[1], 'persistent', 'light turns keep the warm session');

  const { OpenAICompatBrain } = require('../src/main/brain/httpModels');
  const bodies = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (b.reasoning_effort && bodies.length === 2) return { ok: false, status: 400, text: async () => 'Unrecognized request argument: reasoning_effort' };
    const enc = new TextEncoder();
    return { ok: true, status: 200, body: new ReadableStream({ start(ctl) { ctl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n')); ctl.close(); } }) };
  };
  try {
    const g = new OpenAICompatBrain({ config: { baseUrl: 'https://x', model: 'm', reasoningEffort: true, noKey: true }, state: { get() {}, set() {} }, id: 'gemini', name: 'Gemini' });
    await g.ask({ prompt: 'p', onDelta() {}, effort: 'high' });
    assert.strictEqual(bodies[0].reasoning_effort, 'high');
    await g.ask({ prompt: 'p', onDelta() {}, effort: 'medium' });
    assert.strictEqual(bodies[2].reasoning_effort, undefined, 'retried without it after the 400');
    await g.ask({ prompt: 'p', onDelta() {}, effort: 'high' });
    assert.strictEqual(bodies[3].reasoning_effort, undefined, 'and not sent again');
    const plain = new OpenAICompatBrain({ config: { baseUrl: 'https://x', model: 'm', noKey: true }, state: { get() {}, set() {} }, id: 'groq', name: 'Groq' });
    await plain.ask({ prompt: 'p', onDelta() {}, effort: 'high' });
    assert.strictEqual(bodies[4].reasoning_effort, undefined, 'off unless enabled for the provider');
  } finally { global.fetch = realFetch; }
});

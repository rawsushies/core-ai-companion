const test = require('node:test');
const assert = require('node:assert/strict');
const { Brain } = require('../src/main/brain');
const { DEFAULTS, deepMerge } = require('../src/main/config');

function brainWith(primary, fallback) {
  const state = { get: () => undefined, set: () => {} };
  const b = new Brain({ config: deepMerge(DEFAULTS, {}), workDir: '/tmp', state });
  b.chain = [primary, fallback].filter(Boolean);
  return b;
}

const ok = (label, text) => ({ id: 'x', label, name: label, available: () => true, ask: async ({ onDelta }) => { onDelta(text); return { text }; } });
const fail = (label, msg, streamFirst) => ({
  id: 'y', label, name: label, available: () => true,
  ask: async ({ onDelta }) => { if (streamFirst) onDelta('Partial '); throw new Error(msg); },
});

test('falls back when the primary fails before speaking', async () => {
  const items = [];
  const status = [];
  const b = brainWith(fail('Claude', 'not logged in'), ok('Ollama', 'Hello from Ollama. [[explain]]'));
  const r = await b.ask({ text: 'hi', onItem: (i) => items.push(i), onStatus: (s) => status.push(s) });
  assert.equal(r.provider, 'Ollama');
  assert.ok(status.some((s) => s.kind === 'fallback' && s.reason === 'not logged in'));
  assert.deepEqual(items.map((i) => i.type), ['say', 'gesture', 'end']);
});

test('a provider that dies mid-answer keeps the partial reply (no second voice talking over it)', async () => {
  let fallbackCalled = false;
  const fb = ok('Ollama', 'x');
  const fbAsk = fb.ask;
  fb.ask = (...a) => { fallbackCalled = true; return fbAsk(...a); };
  const b = brainWith(fail('Claude', 'boom', true), fb);
  const r = await b.ask({ text: 'hi', onItem: () => {} });
  assert.equal(r.truncated, true);
  assert.match(r.reply, /Partial/);
  assert.match(r.error, /boom/);
  assert.equal(fallbackCalled, false);
});

// A provider that only finishes when aborted (like a hung network stream).
const hang = (label, { after } = {}) => ({
  id: label.toLowerCase(), label, name: label, available: () => true,
  ask: ({ onDelta, signal }) => new Promise((_res, rej) => {
    if (after) onDelta(after);
    signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { aborted: true })));
  }),
});

test('a provider that never answers is abandoned and the next one is used', async () => {
  const b = brainWith(hang('Claude'), ok('Ollama', 'Hello from Ollama.'));
  b.ctx.config.brain.timeouts = { firstTokenMs: 60, idleMs: 60 };
  const status = [];
  const r = await b.ask({ text: 'hi', onItem: () => {}, onStatus: (s) => status.push(s) });
  assert.equal(r.provider, 'Ollama');
  assert.ok(status.some((s) => s.kind === 'fallback' && /no answer within/.test(s.reason)));
  const h = b.health();
  assert.equal(h.find((x) => x.name === 'Claude').fail, 1);
  assert.match(h.find((x) => x.name === 'Claude').lastError, /no answer within/);
  assert.equal(h.find((x) => x.name === 'Ollama').ok, 1);
});

test('a stream that stalls mid-answer ends with what was said, marked truncated', async () => {
  const b = brainWith(hang('Claude', { after: 'The answer is ' }), ok('Ollama', 'x'));
  b.ctx.config.brain.timeouts = { firstTokenMs: 1000, idleMs: 60 };
  const r = await b.ask({ text: 'hi', onItem: () => {} });
  assert.equal(r.truncated, true);
  assert.match(r.error, /stopped answering/);
  assert.match(r.reply, /The answer is/);
});

test('Stop (the user cancelling) is not treated as a provider failure', async () => {
  const b = brainWith(hang('Claude'), ok('Ollama', 'x'));
  const ac = new AbortController();
  const p = b.ask({ text: 'hi', onItem: () => {}, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => e.aborted === true);
  assert.equal((b.health().find((x) => x.name === 'Claude') || {}).fail || 0, 0);
});

test('history stays within message and size budgets and starts with the user', () => {
  const { trimHistory } = require('../src/main/brain/httpModels');
  const big = 'x'.repeat(9000);
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'user', content: i === 9 ? 'last' : big }, { role: 'assistant', content: 'ok' });
  const h = trimHistory(msgs);
  assert.ok(h.reduce((n, m) => n + m.content.length, 0) <= 24000);
  assert.equal(h[0].role, 'user');
  assert.equal(h[h.length - 2].content, 'last');
  assert.ok(trimHistory(Array(40).fill({ role: 'user', content: 'a' })).length <= 24);
});

test('providers that are not connected are skipped quietly', async () => {
  const skipped = { id: 'g', name: 'Gemini', label: 'Gemini', available: () => false, ask: async () => { throw new Error('should not be called'); } };
  const b = brainWith(fail('Claude', 'not logged in'), ok('Groq', 'Hi from Groq.'));
  b.chain = [b.chain[0], skipped, b.chain[1]];
  const r = await b.ask({ text: 'hi', onItem: () => {} });
  assert.equal(r.provider, 'Groq');
});

test('when every brain fails the error names each one', async () => {
  const b = brainWith(fail('Claude', 'not logged in'), fail('Ollama', 'no model'));
  await assert.rejects(b.ask({ text: 'hi', onItem: () => {} }), (e) => /Claude: not logged in/.test(e.message) && /Ollama: no model/.test(e.message));
});

test('old configs with a single "fallback" still build a chain', () => {
  const { chainIds } = require('../src/main/brain');
  assert.deepEqual(chainIds({ provider: 'claude-cli', fallback: 'ollama' }), ['claude-cli', 'ollama']);
  assert.deepEqual(chainIds({ provider: 'claude-cli', fallbacks: ['gemini', 'claude-cli', 'ollama'] }), ['claude-cli', 'gemini', 'ollama']);
});

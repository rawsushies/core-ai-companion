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

test('does not fall back after the primary already started speaking', async () => {
  const b = brainWith(fail('Claude', 'boom', true), ok('Ollama', 'x'));
  await assert.rejects(b.ask({ text: 'hi', onItem: () => {} }), /boom/);
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

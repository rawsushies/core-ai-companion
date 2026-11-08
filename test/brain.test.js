const test = require('node:test');
const assert = require('node:assert/strict');
const { Brain } = require('../src/main/brain');
const { DEFAULTS, deepMerge } = require('../src/main/config');

function brainWith(primary, fallback) {
  const state = { get: () => undefined, set: () => {} };
  const b = new Brain({ config: deepMerge(DEFAULTS, {}), workDir: '/tmp', state });
  b.primary = primary;
  b.fallback = fallback;
  return b;
}

const ok = (label, text) => ({ id: 'x', label, ask: async ({ onDelta }) => { onDelta(text); return { text }; } });
const fail = (label, msg, streamFirst) => ({
  id: 'y', label,
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

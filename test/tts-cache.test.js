'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { TextToSpeech } = require('../src/main/tts');

// A TextToSpeech whose worker is a fake that answers each request.
function fakeTts() {
  const t = new TextToSpeech({ cacheDir: '/nowhere' });
  t.calls = 0;
  t.ready = true;
  t._ensure = () => ({
    postMessage: (m) => {
      if (m.type !== 'speak') return;
      t.calls++;
      const n = m.text.length > 70 ? 24000 * 7 : 12000;
      setImmediate(() => { const p = t.pending.get(m.id); t.pending.delete(m.id); p.resolve({ audio: new Float32Array(n), sampleRate: 24000 }); });
    },
  });
  return t;
}

test('short phrases are synthesised once, then come from the cache', async () => {
  const t = fakeTts();
  const o = { voice: 'am_onyx', semitones: -3, speed: 1 };
  const a = await t.synth('Paused.', o);
  const b = await t.synth('Paused.', o);
  assert.strictEqual(t.calls, 1);
  assert.ok(b.cached && !a.cached);
  assert.strictEqual(b.rate, a.rate);
  await t.synth('Paused.', { ...o, voice: 'am_adam' });
  assert.strictEqual(t.calls, 2, 'another voice is another entry');
  assert.strictEqual(t.busy, 0);
});

test('long sentences and long clips are not cached; the cache is bounded', async () => {
  const t = fakeTts();
  const o = { voice: 'am_onyx', semitones: 0, speed: 1 };
  const long = 'x'.repeat(90);
  await t.synth(long, o); await t.synth(long, o);
  assert.strictEqual(t.calls, 2);
  for (let i = 0; i < 80; i++) await t.synth(`Line ${i}.`, o);
  assert.ok(t.cache.size <= 60);
  t.clearCache();
  assert.strictEqual(t.cache.size, 0);
});

test('prewarm fills the cache in the background', async () => {
  const t = fakeTts();
  const o = { voice: 'am_onyx', semitones: 0, speed: 1 };
  t.prewarm(['Next one.', 'Muted.'], o);
  await new Promise((r) => setTimeout(r, 1200));
  assert.strictEqual(t.calls, 2);
  await t.synth('Muted.', o);
  assert.strictEqual(t.calls, 2);
});

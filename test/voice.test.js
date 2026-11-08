const test = require('node:test');
const assert = require('node:assert/strict');
const { OrderedVoicePipeline, pitchRate } = require('../src/main/tts');
const { persona, forWindowsShell, TONES } = require('../src/main/brain/persona');
const { SpeechPlanner } = require('../src/main/brain/speech');

test('voice pipeline keeps say/gesture order even when later sentences render first', async () => {
  const out = [];
  const delays = { one: 60, two: 5 };
  const p = new OrderedVoicePipeline({
    synth: (text) => new Promise((r) => setTimeout(() => r({ audio: new Float32Array([1]), sampleRate: 24000, rate: 0.8 }), delays[text])),
    forward: (item) => out.push(item.type === 'say' ? `say:${item.text}:${item.audio ? 'audio' : 'none'}` : item.type),
  });
  p.push({ type: 'say', text: 'one' });
  p.push({ type: 'gesture', name: 'explain' });
  p.push({ type: 'say', text: 'two' });
  p.push({ type: 'end' });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(out, ['say:one:audio', 'gesture', 'say:two:audio', 'end']);
});

test('voice pipeline falls back to plain text when synthesis fails, and cancel stops it', async () => {
  const out = [];
  let errors = 0;
  const p = new OrderedVoicePipeline({
    synth: () => Promise.reject(new Error('no model')),
    forward: (item) => out.push(item),
    onError: () => { errors++; },
  });
  p.push({ type: 'say', text: 'hi' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(out[0].text, 'hi');
  assert.equal(out[0].audio, undefined);
  assert.equal(errors, 1);
  p.cancel();
  p.push({ type: 'say', text: 'ignored' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(out.length, 1);
});

test('pitch shift maths', () => {
  assert.equal(pitchRate(0), 1);
  assert.ok(Math.abs(pitchRate(-12) - 0.5) < 1e-9);
  assert.ok(pitchRate(-3) < 1);
});

test('every tone is safe for the Windows shell and lands in the persona', () => {
  for (const [name, text] of Object.entries(TONES)) {
    assert.equal(forWindowsShell(text), text, `${name} contains shell metacharacters`);
    assert.ok(persona({ canReadFiles: false, tone: name }).includes(text));
  }
  assert.ok(persona({ canReadFiles: false }).includes(TONES.sarcastic), 'sarcastic is the default');
  assert.equal(forWindowsShell(persona({ canReadFiles: true })).includes('"'), false);
});

test('typed chat: full text streams to the chat, only the opening is spoken', () => {
  const said = [];
  let shown = '';
  const p = new SpeechPlanner((i) => { if (i.type === 'say') said.push(i.text); }, { onText: (t) => { shown += t; }, maxSpoken: 2 });
  p.feed('Fine, I will explain it slowly. Here is the gist of the thing. ');
  p.feed('Step one is boring but needed.\n\n- item one\n- item two\n');
  p.finish();
  assert.equal(said.length, 2);
  assert.ok(shown.includes('- item two'));
});

test('TextToSpeech renders sentences one at a time, in order', async () => {
  const { TextToSpeech } = require('../src/main/tts');
  const t = new TextToSpeech({ cacheDir: '/tmp' });
  const order = [];
  let active = 0;
  let maxActive = 0;
  t._ensure = () => ({
    postMessage: (m) => {
      active++; maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active--; order.push(m.text);
        t.pending.get(m.id).resolve({ audio: new Float32Array(1), sampleRate: 24000 });
        t.pending.delete(m.id);
      }, m.text === 'one' ? 40 : 5);
    },
  });
  const r = await Promise.all(['one', 'two', 'three'].map((x) => t.synth(x, { voice: 'am_onyx', semitones: -3 })));
  assert.deepEqual(order, ['one', 'two', 'three']);
  assert.equal(maxActive, 1);
  assert.ok(r[0].rate < 1);
});

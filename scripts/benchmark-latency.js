'use strict';

// Response-time benchmark with COre's real components (no mocks):
//   - end-of-turn wait: the microphone's silence rule (src/renderer/overlay/listen.js)
//   - speech recognition: the real Whisper worker on a real spoken clip (made by COre's own voice)
//   - brain: time to first words from real providers (Groq, Gemini) through COre's provider code
//   - voice: the real Kokoro worker, first sentence vs first clause
// It adds them up into "you stop talking -> COre's first sound" and "-> first word",
// compared with the targets in docs/dev/PLAN-12.1.md.
//
//   NODE_USE_ENV_PROXY=1 node scripts/benchmark-latency.js [--models DIR] [--provider groq,gemini] [--runs 5] [--out docs/LATENCY.md]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SpeechToText } = require('../src/main/stt');
const { TextToSpeech } = require('../src/main/tts');
const { OpenAICompatBrain } = require('../src/main/brain/httpModels');
const { pct } = require('../src/main/latency');
const defaults = require('../src/main/config');

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const MODELS = path.resolve(arg('--models', path.join(os.homedir(), '.core-models')));
const RUNS = Number(arg('--runs', 5));
const PROVIDERS = arg('--provider', 'groq,gemini').split(',').filter(Boolean);
const OUT = arg('--out', '');
const NAMES = { groq: 'Groq', gemini: 'Gemini', openrouter: 'OpenRouter' };
const now = () => performance.now();
const p = (a) => ({ p50: Math.round(pct(a, 50)), p95: Math.round(pct(a, 95)) });

// The silence rule, read from the shipped microphone code.
const listenSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'overlay', 'listen.js'), 'utf8');
const CHUNK_MS = Number((/CHUNK_MS = (\d+)/.exec(listenSrc) || [])[1] || 100);
const SILENCE_CHUNKS = Number((/SILENCE_CHUNKS = (\d+)/.exec(listenSrc) || [])[1] || 6);
const ENDPOINT_MS = CHUNK_MS * SILENCE_CHUNKS;

function resample(f32, from, to) {
  const n = Math.round((f32.length * to) / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i * from) / to; const i0 = Math.floor(x); const t = x - i0; out[i] = (f32[i0] || 0) * (1 - t) + (f32[i0 + 1] || 0) * t; }
  return out;
}

async function main() {
  const rows = [];
  const tts = new TextToSpeech({ cacheDir: MODELS, quality: 'fast' });
  const stt = new SpeechToText({ model: 'onnx-community/whisper-base', language: 'en', cacheDir: MODELS });
  try {
    // Voice: warm, then first sentence vs first clause (unique text each run so nothing is cached).
    let t = now(); await tts.synth('Ready.', { voice: 'am_michael' }); const ttsCold = now() - t;
    const sent = [], clause = [];
    for (let i = 0; i < RUNS; i++) {
      t = now(); await tts.synth(`Sure, the Tower client chose a glass facade with bronze mullions, option ${i + 2}.`, { voice: 'am_michael' }); sent.push(now() - t);
      t = now(); await tts.synth(`Sure, option ${i + 2} it is.`, { voice: 'am_michael' }); clause.push(now() - t);
    }
    rows.push(['Voice: first sentence (Kokoro q4, warm)', p(sent)], ['Voice: first clause, ~5 words (warm)', p(clause)]);
    console.log(`voice cold start ${Math.round(ttsCold)} ms; sentence`, p(sent), 'clause', p(clause));

    // Speech recognition on a real spoken question (COre's own voice, resampled to 16 kHz).
    const q = await tts.synth('What did the Tower client decide about the facade?', { voice: 'af_heart' });
    const clip = resample(q.audio, q.sampleRate || 24000, 16000);
    t = now(); await stt.transcribe(new Float32Array(16000)); const sttCold = now() - t;
    const rec = []; let heard = '';
    for (let i = 0; i < RUNS; i++) { t = now(); heard = await stt.transcribe(new Float32Array(clip)); rec.push(now() - t); }
    rows.push([`Speech recognition, ${(clip.length / 16000).toFixed(1)} s question (Whisper base, warm)`, p(rec)]);
    console.log(`stt cold ${Math.round(sttCold)} ms; warm`, p(rec), `heard "${heard}"`);

    // Brains: time to first words for a quick conversational turn.
    const firstWords = {};
    for (const id of PROVIDERS) {
      const cfg = { ...defaults.DEFAULTS.brain[id] };
      const mem = {}; const state = { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } };
      const b = new OpenAICompatBrain({ config: cfg, state, id, name: NAMES[id], getKey: () => 'proxy-injected' });
      const tt = [];
      for (let i = 0; i < RUNS; i++) {
        let first = 0; t = now();
        try { await b.ask({ prompt: `Reply with one short friendly sentence about the number ${i + 3}.`, onDelta: () => { if (!first) first = now() - t; } }); } catch (err) { console.log(`${id}: ${err.message}`); break; }
        if (first) tt.push(first);
        b.resetConversation();
      }
      if (tt.length) { firstWords[id] = p(tt); rows.push([`Brain first words: ${NAMES[id]} (${b.cfg.model || 'auto'})`, firstWords[id]]); console.log(id, firstWords[id]); }
    }

    // Composition: today's voice turn.
    const best = Object.values(firstWords).sort((a, b) => a.p50 - b.p50)[0];
    const reactNow = ENDPOINT_MS; // the orb reacts when the silence rule ends the turn
    const firstAudioNow = best ? ENDPOINT_MS + p(rec).p50 + best.p50 + p(sent).p50 : null;
    rows.push([`End-of-turn wait (silence rule: ${SILENCE_CHUNKS} × ${CHUNK_MS} ms)`, { p50: ENDPOINT_MS, p95: ENDPOINT_MS }]);
    const summary = [
      `You stop talking → COre reacts: **${reactNow} ms** (target ≤ 300 ms)`,
      firstAudioNow ? `You stop talking → first word (fastest brain, sequential today): **${Math.round(firstAudioNow)} ms** (target ≤ 1000 ms) = wait ${ENDPOINT_MS} + recognition ${p(rec).p50} + brain ${best.p50} + voice ${p(sent).p50}` : 'First word: no brain reachable',
    ];
    console.log(summary.join('\n'));

    if (OUT) {
      const md = ['# Response times', '', `Measured ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by \`node scripts/benchmark-latency.js\` on ${os.cpus()[0].model.trim()} (${os.cpus().length} threads), ${RUNS} runs each. Real components: COre's Whisper and Kokoro workers, its provider code against the live APIs. Targets: docs/dev/PLAN-12.1.md.`, '', ...summary.map((s) => `- ${s}`), '', '| Step | p50 | p95 |', '|---|---|---|', ...rows.map(([n, v]) => `| ${n} | ${v.p50} ms | ${v.p95} ms |`), '', `Cold starts (first use after launch): voice ${Math.round(ttsCold)} ms, recognition ${Math.round(sttCold)} ms.`, ''];
      fs.writeFileSync(path.resolve(OUT), md.join('\n'));
      console.log(`wrote ${OUT}`);
    }
  } finally {
    stt.dispose(); tts.dispose();
  }
  setTimeout(() => process.exit(0), 300);
}

main().catch((err) => { console.error(err); process.exit(1); });

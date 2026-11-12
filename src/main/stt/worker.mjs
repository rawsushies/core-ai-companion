// Local speech-to-text with Whisper (transformers.js + onnxruntime-node).
// Runs in a worker thread so the main process never stutters. The model is
// downloaded from Hugging Face once and cached in COre's data folder.

import { parentPort, workerData } from 'node:worker_threads';

let loading = null;
let primed = false;
// Fast English recognizer (Moonshine): its cost follows the clip length instead of
// Whisper's fixed 30 s window, so a 3 s question takes ~0.25 s instead of ~0.6 s.
let fastLoading = null;
let fastPrimed = false;
function loadFast() {
  if (!fastLoading) {
    fastLoading = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = workerData.cacheDir;
      env.allowLocalModels = false;
      return pipeline('automatic-speech-recognition', workerData.fastModel, { dtype: 'q8' });
    })();
    fastLoading.catch(() => { fastLoading = null; });
  }
  return fastLoading;
}

// Whisper's classic hallucinations on near-silence.
const HALLUCINATIONS = /^(thank you\.?|thanks for watching\.?|you|\.|terima kasih\.?|\[.*\]|\(.*\))$/i;

function load() {
  if (!loading) {
    loading = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = workerData.cacheDir;
      env.allowLocalModels = false;
      const progress_callback = (p) => {
        if (p.status === 'progress' && p.total) {
          parentPort.postMessage({ type: 'progress', file: p.file, pct: Math.round((p.loaded / p.total) * 100) });
        }
      };
      try {
        return await pipeline('automatic-speech-recognition', workerData.model, {
          dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' },
          progress_callback,
        });
      } catch {
        // Some checkpoints don't ship the q4 decoder; use the defaults.
        return pipeline('automatic-speech-recognition', workerData.model, { progress_callback });
      }
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'warm') {
    try {
      if (workerData.fast && workerData.fastModel) {
        const f = await loadFast().catch(() => null);
        if (f && !fastPrimed) { fastPrimed = true; await f(new Float32Array(8000)).catch(() => {}); }
      }
      const asr = await load();
      // The first inference is slow; do it now on half a second of silence.
      if (!primed) { primed = true; await asr(new Float32Array(8000), { task: 'transcribe' }).catch(() => {}); }
      parentPort.postMessage({ type: 'ready' });
    } catch (err) {
      parentPort.postMessage({ type: 'error', id: null, message: explain(err) });
    }
    return;
  }
  if (msg.type !== 'transcribe') return;
  try {
    if (msg.fast && workerData.fastModel) {
      const f = await loadFast().catch(() => null);
      if (f) {
        const out = await f(msg.audio);
        let text = String((out && out.text) || '').trim();
        if (HALLUCINATIONS.test(text)) text = '';
        parentPort.postMessage({ type: 'result', id: msg.id, text, fast: true });
        return;
      }
    }
    const asr = await load();
    const opts = { task: 'transcribe', chunk_length_s: 30 };
    if (workerData.language) opts.language = workerData.language;
    const out = await asr(msg.audio, opts);
    let text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text || '').trim();
    if (HALLUCINATIONS.test(text)) text = '';
    parentPort.postMessage({ type: 'result', id: msg.id, text });
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: explain(err) });
  }
});

function explain(err) {
  const m = String(err && err.message || err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(m)) {
    return `could not download the speech model ${workerData.model} (needs internet the first time)`;
  }
  return m;
}

// Local neural text-to-speech (Kokoro-82M via kokoro-js, Apache-2.0).
// Runs in a worker thread; the model (~90 MB) is downloaded once and cached.
import { parentPort, workerData } from 'node:worker_threads';

let loading = null;
let primed = false;

function load() {
  if (!loading) {
    loading = (async () => {
      const { env } = await import('@huggingface/transformers');
      env.cacheDir = workerData.cacheDir;
      const { KokoroTTS } = await import('kokoro-js');
      // q4 renders ~3x faster than q8 on typical CPUs ("best" = q8).
      return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
        dtype: workerData.quality === 'best' ? 'q8' : 'q4',
        device: 'cpu',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            parentPort.postMessage({ type: 'progress', file: p.file, pct: Math.round((p.loaded / p.total) * 100) });
          }
        },
      });
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

function explain(err) {
  const m = String((err && err.message) || err);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(m)) {
    return 'could not download the voice model (needs internet the first time)';
  }
  return m;
}

parentPort.on('message', async (msg) => {
  if (msg.type === 'warm') {
    try {
      const tts = await load();
      // The first inference is slow (ONNX warm-up): do it now, not on a reply.
      if (!primed) { primed = true; await tts.generate('Ready.', { voice: 'am_onyx' }).catch(() => {}); }
      parentPort.postMessage({ type: 'ready' });
    }
    catch (err) { parentPort.postMessage({ type: 'error', id: null, message: explain(err) }); }
    return;
  }
  if (msg.type !== 'speak') return;
  try {
    const tts = await load();
    const voice = tts.voices && tts.voices[msg.voice] ? msg.voice : 'am_onyx';
    const out = await tts.generate(msg.text, { voice, speed: msg.speed || 1 });
    const audio = out.audio instanceof Float32Array ? out.audio : new Float32Array(out.audio);
    parentPort.postMessage({ type: 'audio', id: msg.id, audio, sampleRate: out.sampling_rate }, [audio.buffer]);
  } catch (err) {
    parentPort.postMessage({ type: 'error', id: msg.id, message: explain(err) });
  }
});

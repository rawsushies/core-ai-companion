// Downloads the local AI models COre uses (speech recognition, voice, memory
// embeddings) into a folder, with the same loaders and settings the app uses, so
// the installer can ship them and COre works offline from the first start.
//   node scripts/prefetch-models.mjs vendor/models
import path from 'node:path';
import fs from 'node:fs';

const out = path.resolve(process.argv[2] || 'vendor/models');
fs.mkdirSync(out, { recursive: true });
const { env, pipeline } = await import('@huggingface/transformers');
env.cacheDir = out;
env.allowLocalModels = false;

const t0 = Date.now();
// Same model ids and dtypes as src/main/stt, tts and embed workers (and config.voice.sttModel's default).
const stt = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base', { dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' } });
await stt.dispose?.();
// The fast English recognizer (same settings as the stt worker's fast path).
const fast = await pipeline('automatic-speech-recognition', 'onnx-community/moonshine-base-ONNX', { dtype: 'q8' });
await fast.dispose?.();
const fe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
const v = await fe('COre works offline', { pooling: 'mean', normalize: true });
await fe.dispose?.();
const { KokoroTTS } = await import('kokoro-js');
for (const dtype of ['q4', 'q8']) { // q4 = default quality, q8 = "best"
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype, device: 'cpu' });
  if (dtype === 'q4') { const a = await tts.generate('Ready.', { voice: 'af_heart' }); if (!a || !a.audio || !a.audio.length) throw new Error('voice model produced no audio'); }
}
const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`models ready in ${out}: ${(size(out) / 1e6).toFixed(0)} MB, embedding dim ${v.dims.at(-1)}, ${Math.round((Date.now() - t0) / 1000)} s`);
for (const id of ['onnx-community/whisper-base', 'onnx-community/moonshine-base-ONNX', 'Xenova/all-MiniLM-L6-v2', 'onnx-community/Kokoro-82M-v1.0-ONNX']) if (!fs.existsSync(path.join(out, id))) { console.error(`missing ${id}`); process.exit(1); }

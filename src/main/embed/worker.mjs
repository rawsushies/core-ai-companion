// Embedding worker: a small sentence-embedding model (all-MiniLM-L6-v2, q8,
// about 23 MB, downloaded once into COre's models folder) for semantic memory
// search. Runs off the main thread.
import { parentPort, workerData } from 'node:worker_threads';
import { pipeline, env } from '@huggingface/transformers';

env.cacheDir = workerData.cacheDir;
env.allowLocalModels = true;
let fe = null;
const ready = (async () => { fe = await pipeline('feature-extraction', workerData.model || 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' }); })();

parentPort.on('message', async ({ id, texts }) => {
  try {
    await ready;
    const out = await fe(texts, { pooling: 'mean', normalize: true });
    parentPort.postMessage({ id, vecs: out.tolist() });
  } catch (err) {
    parentPort.postMessage({ id, error: String(err && err.message || err) });
  }
});

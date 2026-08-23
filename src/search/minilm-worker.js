import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync } from 'node:fs';

/**
 * Encoder worker: keeps ONNX inference off the main thread so embedding batches
 * never stall the web server or WhatsApp socket.
 *
 * Protocol
 *   parent -> worker : { id, texts }
 *   worker -> parent : { id, dim, flat }            (flat = dim * texts.length)
 *                    | { id, error }
 *                    | { ready } | { ready, error } (once, at startup)
 */

const { modelId, cacheDir } = workerData;

let extractor = null;

async function init() {
  const { pipeline, env } = await import('@huggingface/transformers');
  mkdirSync(cacheDir, { recursive: true });
  env.cacheDir = cacheDir;
  env.allowLocalModels = true;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
  }
  extractor = await pipeline('feature-extraction', modelId, { dtype: 'q8', device: 'cpu' });
}

const ready = init().then(
  () => parentPort.postMessage({ ready: true }),
  (err) => {
    parentPort.postMessage({ ready: false, error: err?.message || String(err) });
    throw err;
  },
);

parentPort.on('message', async ({ id, texts }) => {
  try {
    await ready;
    const out = await extractor(texts, { pooling: 'mean', normalize: true });
    const rows = typeof out.tolist === 'function' ? out.tolist() : out;
    const list = Array.isArray(rows[0]) ? rows : [rows];
    const dim = list[0]?.length ?? 0;
    const flat = new Float32Array(list.length * dim);
    for (let i = 0; i < list.length; i++) flat.set(list[i], i * dim);
    parentPort.postMessage({ id, dim, flat }, [flat.buffer]);
  } catch (err) {
    parentPort.postMessage({ id, error: err?.message || String(err) });
  }
});

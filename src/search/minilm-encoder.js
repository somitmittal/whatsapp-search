import { Worker } from 'node:worker_threads';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';

/**
 * Same MiniLM checkpoint referenced by the in-app search preview (~23MB, 384-d).
 * CPU, one ONNX thread — avoids competing with Ollama GPU/Metal during summaries.
 */
export const MINILM_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/**
 * The checkpoint stops at 256 tokens (~1000 chars); anything longer is dropped by the
 * model anyway, but an untruncated batch still pads every row to the longest input,
 * and attention is quadratic in that length. Measured on 28,935 real messages
 * (p50 23 chars, p95 245, max 12,080): capping here costs no recall and stops a
 * single long message from dominating — and OOM-ing — its batch.
 */
export const MINILM_MAX_CHARS = 1000;

const WORKER_URL = new URL('./minilm-worker.js', import.meta.url);

let worker = null;
let nextId = 1;
/** @type {Map<number, { resolve: Function, reject: Function }>} */
const pending = new Map();

function failAllPending(err) {
  for (const { reject } of pending.values()) reject(err);
  pending.clear();
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(fileURLToPath(WORKER_URL), {
    workerData: { modelId: MINILM_MODEL_ID, cacheDir: join(config.dataDir, 'models') },
  });
  // Never hold the process open; shutdown goes through terminateMiniLmEncoder().
  worker.unref();

  worker.on('message', (msg) => {
    if (msg?.ready !== undefined) return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) {
      entry.reject(new Error(msg.error));
      return;
    }
    const { dim, flat } = msg;
    const rows = [];
    for (let i = 0; dim > 0 && i < flat.length / dim; i++) {
      rows.push(flat.subarray(i * dim, (i + 1) * dim));
    }
    entry.resolve(rows);
  });

  // A crashed or exited worker must not leave callers hanging forever — that would
  // wedge the caller's in-flight guard and silently stop indexing.
  worker.on('error', (err) => {
    worker = null;
    failAllPending(err);
  });
  worker.on('exit', (code) => {
    worker = null;
    failAllPending(new Error(`MiniLM worker exited (code ${code})`));
  });

  return worker;
}

/**
 * @param {string[]} texts
 * @returns {Promise<Float32Array[]>}
 */
export async function encodeTexts(texts) {
  if (!texts?.length) return [];
  const capped = texts.map((t) => (t.length > MINILM_MAX_CHARS ? t.slice(0, MINILM_MAX_CHARS) : t));
  const w = getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, texts: capped });
  });
}

export async function terminateMiniLmEncoder() {
  if (!worker) return;
  const w = worker;
  worker = null;
  failAllPending(new Error('MiniLM worker terminated'));
  await w.terminate();
}

export function resetMiniLmEncoderForTests() {
  void terminateMiniLmEncoder();
}

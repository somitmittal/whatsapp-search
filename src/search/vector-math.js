/**
 * Float32 vector helpers for MiniLM embeddings stored in SQLite BLOBs.
 */

export function packF32(values) {
  const arr = values instanceof Float32Array ? values : Float32Array.from(values);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function unpackF32(blob) {
  if (!blob || !blob.length) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.byteLength % 4 !== 0) return null;
  const aligned = buf.byteOffset % 4 === 0 ? buf : Buffer.from(buf);
  return new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!denom) return 0;
  return dot / denom;
}

/**
 * Keep the best `k` rows by cosine similarity. `rows` is scanned once.
 * @param {Float32Array} query
 * @param {Array<{ vector: Float32Array, id: number }>} rows
 * @param {number} k
 */
export function topKByCosine(query, rows, k) {
  const limit = Math.max(1, k);
  /** @type {Array<{ id: number, score: number }>} */
  const best = [];
  for (const row of rows) {
    const score = cosineSimilarity(query, row.vector);
    if (best.length < limit) {
      best.push({ id: row.id, score });
      best.sort((a, b) => a.score - b.score);
      continue;
    }
    if (score > best[0].score) {
      best[0] = { id: row.id, score };
      best.sort((a, b) => a.score - b.score);
    }
  }
  return best.sort((a, b) => b.score - a.score);
}

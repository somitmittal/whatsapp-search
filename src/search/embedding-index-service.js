import { embeddableText, embeddingSourceHash } from './embedding-text.js';
import { encodeTexts, MINILM_MODEL_ID } from './minilm-encoder.js';
import { packF32, unpackF32, topKByCosine } from './vector-math.js';
import config from '../config.js';

/** Same default batch as media indexing (`processPending(12)`). */
const DEFAULT_BATCH = 12;

export default class EmbeddingIndexService {
  constructor({
    db,
    encode = encodeTexts,
    modelId = MINILM_MODEL_ID,
    getPriorityChatJid = null,
    isWaLive = null,
    shouldDefer = null,
  }) {
    this._db = db;
    this._encode = encode;
    this._modelId = modelId;
    this._getPriorityChatJid = typeof getPriorityChatJid === 'function' ? getPriorityChatJid : null;
    this._isWaLive = typeof isWaLive === 'function' ? isWaLive : null;
    this._shouldDefer = typeof shouldDefer === 'function' ? shouldDefer : null;
    this._scheduled = null;
    this._running = false;
    this._preemptRequested = false;
    this._unavailable = false;
  }

  scheduleProcess() {
    if (this._scheduled) clearTimeout(this._scheduled);
    this._scheduled = setTimeout(() => {
      this._scheduled = null;
      this.processPending().catch((e) => console.warn('[Embeddings]', e.message));
    }, 1500);
  }

  notePriorityChange() {
    this._preemptRequested = true;
  }

  /** True while an embedding batch is in flight — drives the sidebar sync indicator. */
  isBusy() {
    return this._running;
  }

  async processPending(limit = DEFAULT_BATCH) {
    if (this._shouldDefer?.()) return 0;
    if (this._unavailable) return 0;
    if (this._running) {
      this._preemptRequested = true;
      return 0;
    }
    this._running = true;
    let done = 0;
    let brokeEarly = false;
    try {
      const prio = this._getPriorityChatJid?.() ?? null;
      const waLive = this._isWaLive ? this._isWaLive() !== false : true;
      const recentCutoffTs = Math.floor(Date.now() / 1000)
        - (config.liveRecentWindowDays * 24 * 60 * 60);
      const sourceScopes = waLive ? ['live', 'imported'] : ['imported', 'live'];
      let jobs = this._db.getPendingEmbeddingJobs(limit, prio, this._modelId, {
        waLive,
        sourceScope: sourceScopes[0],
        recentCutoffTs,
      });
      if (jobs.length === 0) {
        jobs = this._db.getPendingEmbeddingJobs(limit, prio, this._modelId, {
          waLive,
          sourceScope: sourceScopes[1],
          recentCutoffTs,
        });
      }
      const ready = [];
      for (const job of jobs) {
        const text = embeddableText(job);
        if (!text) {
          this._db.upsertMessageEmbedding({
            messageRowid: job.id,
            model: this._modelId,
            dim: 0,
            vector: Buffer.alloc(0),
            sourceHash: embeddingSourceHash(''),
          });
          continue;
        }
        ready.push({ job, text, hash: embeddingSourceHash(text) });
      }
      if (ready.length) {
        const vectors = await this._encode(ready.map((r) => r.text));
        if (!vectors?.length || vectors.length !== ready.length) {
          throw new Error(`encoder returned ${vectors?.length ?? 0} vectors for ${ready.length} texts`);
        }
        for (let i = 0; i < ready.length; i++) {
          if (this._shouldDefer?.()) {
            brokeEarly = true;
            break;
          }
          const vec = vectors[i];
          this._db.upsertMessageEmbedding({
            messageRowid: ready[i].job.id,
            model: this._modelId,
            dim: vec.length,
            vector: packF32(vec),
            sourceHash: ready[i].hash,
          });
          done += 1;
          if (this._preemptRequested) {
            brokeEarly = true;
            break;
          }
        }
      }
    } catch (err) {
      const msg = err?.message || String(err);
      if (/Cannot find package|Cannot find module|Failed to fetch|network/i.test(msg)) {
        this._unavailable = true;
        console.warn('[Embeddings] Encoder unavailable — semantic search disabled until restart:', msg);
      } else {
        console.warn('[Embeddings]', msg);
      }
    } finally {
      this._preemptRequested = false;
      this._running = false;
    }
    if (done > 0) console.log(`[Embeddings] Indexed ${done} message(s)`);
    if (brokeEarly) this.scheduleProcess();
    return done;
  }

  /**
   * @param {string} query
   * @param {string|null} chatJid
   * @param {number} k
   * @returns {Promise<Array<{ id: number, score: number }>>}
   */
  async searchSimilar(query, chatJid = null, k = 30) {
    const q = String(query || '').trim();
    if (!q || this._unavailable) return [];
    let qvec;
    try {
      const encoded = await this._encode([q]);
      qvec = encoded?.[0];
    } catch (err) {
      console.warn('[Embeddings] query encode:', err.message);
      return [];
    }
    if (!qvec?.length) return [];

    const packed = this._db.iterateMessageEmbeddings(this._modelId, chatJid);
    const rows = [];
    for (const row of packed) {
      const vector = unpackF32(row.vector);
      if (!vector || vector.length !== qvec.length) continue;
      rows.push({ id: row.messageRowid, vector });
    }
    return topKByCosine(qvec, rows, k);
  }
}

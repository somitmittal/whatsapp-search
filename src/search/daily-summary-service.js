import { FACT_EXTRACTION_PROMPT, parseFactsFromLlm } from './fact-extract.js';
import { segmentIntoThreads } from './thread-segment.js';
import { isWhatsAppLowPriorityFeed } from '../whatsapp/jid-filters.js';
import { getCurrentTenantId } from '../storage/tenant-context.js';
import { prioritizeChatFirst } from './priority-chat-queue.js';
/** Messages per LLM call — keeps prompts bounded and allows parallel segment work. */
const SUMMARY_CHUNK_CLOUD = 200;
const SUMMARY_CHUNK_LOCAL = 150;
/** Parallel segment-summary calls per thread (speed without hammering the API). */
const CHUNK_SUMMARY_CONCURRENCY = 3;
// Min delay between batches (ms) — kept small because key-rotation handles rate limits
const DELAY_CLOUD_MS = 500;
const DELAY_LOCAL_MS = 2000;
// Default concurrency when provider exposes no key count
const DEFAULT_CONCURRENCY = 3;
/** Cap for thread-batch parallelism (non-local). */
const SUMMARY_CONCURRENCY_MAX = 8;
/** Default thread-batch concurrency for cloud/API when SUMMARY_CONCURRENCY is unset (min 2 vs key count). */
const DEFAULT_CLOUD_SUMMARY_CONCURRENCY = 7;
/** Longer than default provider HTTP timeout — summaries + merges can be slow on large threads. */
const SUMMARY_LLM_TIMEOUT_MS = 180_000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Thread-batch concurrency for cloud/API providers.
 * - If SUMMARY_CONCURRENCY (or SUMMARY_THREAD_CONCURRENCY) is set, that value wins (clamped 1–SUMMARY_CONCURRENCY_MAX).
 * - Otherwise: max(DEFAULT_CLOUD_SUMMARY_CONCURRENCY, key count) so single-key cloud uses 2; more keys still scale up.
 * Local Ollama stays at 1. Total tokens for a fixed backlog are ~unchanged; higher concurrency raises peak RPM/TPM and can trigger rate limits.
 */
function parseSummaryConcurrencyEnv() {
  const raw = process.env.SUMMARY_CONCURRENCY ?? process.env.SUMMARY_THREAD_CONCURRENCY;
  if (raw === undefined || String(raw).trim() === '') return null;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(SUMMARY_CONCURRENCY_MAX, n);
}

/** Small local models (≤ 4B params) can handle parallel requests without saturating memory. */
const LOCAL_SMALL_MODEL_CONCURRENCY = 3;

function getSummaryThreadConcurrency(isLocal, keyCount, modelName) {
  const override = parseSummaryConcurrencyEnv();
  if (override !== null) return override;
  if (isLocal) {
    return isSmallLocalModel(modelName) ? LOCAL_SMALL_MODEL_CONCURRENCY : 1;
  }
  return Math.max(DEFAULT_CLOUD_SUMMARY_CONCURRENCY, keyCount || 1);
}

function isSmallLocalModel(modelName) {
  if (!modelName) return false;
  const m = String(modelName).toLowerCase();
  const sizeMatch = m.match(/(\d+(?:\.\d+)?)\s*b/);
  if (sizeMatch) {
    const params = parseFloat(sizeMatch[1]);
    if (params <= 4) return true;
  }
  if (m.includes(':1b') || m.includes(':3b') || m.includes(':1.5b') || m.includes(':2b')) return true;
  return false;
}

const DELAY_LOCAL_SMALL_MS = 300;

/** Optional delay between cloud thread batches (ms); default DELAY_CLOUD_MS. Raise if SUMMARY_CONCURRENCY > 1 causes 429s. */
function getCloudBatchDelayMs(isLocal) {
  if (isLocal) return DELAY_LOCAL_MS;
  const raw = process.env.SUMMARY_BATCH_DELAY_MS;
  if (raw === undefined || String(raw).trim() === '') return DELAY_CLOUD_MS;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 0) return DELAY_CLOUD_MS;
  return Math.min(120_000, n);
}

function isAbortOrTimeoutErr(err) {
  const msg = `${err?.name || ''} ${err?.message || ''} ${err?.cause?.message || ''}`;
  return /aborted|AbortError|timeout|timed out/i.test(msg);
}

/** Options merged into every summary / merge / facts LLM call. */
function summaryLlmOptions(extra = {}) {
  return { timeoutMs: SUMMARY_LLM_TIMEOUT_MS, ...extra };
}

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

const SUMMARY_PROMPT =
  'Summarize this WhatsApp conversation thread in 2-4 keyword-rich sentences.\n\n' +
  'Rules:\n' +
  '- Include ALL specific names, numbers, dates, prices, and locations mentioned.\n' +
  '- Cover every distinct topic discussed, decision made, or key fact.\n' +
  '- Use the exact words and phrases participants used (critical for search matching).\n' +
  '- Capture who said what — attribute key statements to speakers by name.\n' +
  '- Note the TONE: arguments, disagreements, debates, excitement, humor, frustration, consensus.\n' +
  '- If people had a heated exchange or conflict, mention who was involved and what it was about.\n' +
  '- Do NOT add opinions or filler. Factual + tonal summary only.\n\n';

export default class DailySummaryService {
  constructor({ db, provider = null, fallbackProvider = null, onProgress }) {
    this._db = db;
    this._provider = provider;
    this._fallback = fallbackProvider;
    this._onProgress = onProgress ?? null;
    this._running = false;
    this._aborted = false;
    this._preemptRequested = false;
    /** @type {Map<string, string>} tenantId → chatJid to process first on next run */
    this._priorityChatJidByTenant = new Map();
    /** @type {Map<string, boolean>} tenantId → true once the initial priority pass completed */
    this._initialPassDone = new Map();
  }

  /**
   * Active priority chat for a tenant (media indexing order), if any.
   * @param {string} tenantId
   * @returns {string|null}
   */
  getPriorityChatForTenant(tenantId) {
    if (!tenantId) return null;
    return this._priorityChatJidByTenant.get(String(tenantId)) ?? null;
  }

  /**
   * Prefer indexing this chat before others (same tenant). Consumed after that chat is processed once.
   * @param {string} tenantId
   * @param {string} chatJid
   */
  setPriorityChatForTenant(tenantId, chatJid) {
    if (!tenantId || !chatJid) return;
    this._priorityChatJidByTenant.set(String(tenantId), String(chatJid));
  }

  /** Split a message array into consecutive chunks of at most `size` messages. */
  _splitIntoChunks(messages, size) {
    if (!messages?.length || size < 1) return [];
    const out = [];
    for (let i = 0; i < messages.length; i += size) {
      out.push(messages.slice(i, i + size));
    }
    return out;
  }

  setProvider(provider) {
    this._provider = provider;
    if (this._running) {
      console.log('[Summaries] Summary provider updated — remaining threads will use the new provider on the next batch');
    }
  }

  setFallbackProvider(provider) {
    this._fallback = provider;
  }

  _isLocal(provider) {
    return provider?.name === 'ollama';
  }

  async _collectFactsFromTranscript(provider, transcript) {
    if (!provider || !transcript?.trim()) return [];
    const prompt = `${FACT_EXTRACTION_PROMPT}\n${transcript}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = await provider.chat(
          [{ role: 'user', content: prompt }],
          summaryLlmOptions({ temperature: 0.1, maxTokens: 2000 }),
        );
        return parseFactsFromLlm(raw);
      } catch (err) {
        const msg = err.message || '';
        const is429 = msg.includes('429');
        const isAbort = isAbortOrTimeoutErr(err);
        if ((is429 || isAbort) && attempt < 2) {
          const waitMs = is429 ? 5000 : 6000 * (attempt + 1);
          if (isAbort) console.log(`[Facts] Request aborted/timeout, retry in ${waitMs / 1000}s (${attempt + 1}/3)`);
          await sleep(waitMs);
          continue;
        }
        console.error(`[Facts] ✗ chunk:`, msg.slice(0, 120));
        return [];
      }
    }
    return [];
  }

  _dedupeFacts(facts) {
    const seen = new Set();
    const out = [];
    for (const f of facts) {
      if (!f || typeof f !== 'object') continue;
      const key = String(f.search_text || '').toLowerCase().slice(0, 400) || JSON.stringify(f).slice(0, 500);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out;
  }

  /** Second pass: structured facts for hybrid search (same provider as thread summary). */
  async _extractFacts(provider, transcript, chatJid, chatName, threadStart, threadEnd) {
    const facts = await this._collectFactsFromTranscript(provider, transcript);
    if (facts.length === 0) return;
    const n = this._db.replaceThreadFacts({
      chatJid, chatName, threadStart, threadEnd, facts,
    });
    if (n > 0) console.log(`[Facts] ✓ ${n} facts for thread ${threadStart}`);
  }

  async _pickProvider() {
    if (this._provider) {
      try {
        const ok = await this._provider.checkHealth();
        if (ok) return this._provider;
        console.log(`[Summaries] Primary provider ${this._provider.name}/${this._provider.model} not reachable`);
      } catch {}
    }
    if (this._fallback) {
      try {
        const ok = await this._fallback.checkHealth();
        if (ok) {
          console.log(`[Summaries] Using fallback provider: ${this._fallback.name}/${this._fallback.model}`);
          return this._fallback;
        }
      } catch {}
    }
    return null;
  }

  async indexPendingDays() {
    if (this._running) {
      this._restartPending = true;
      this._preemptRequested = true;
      console.log('[Summaries] Already running — current pass will yield for priority / queued restart');
      return 0;
    }

    let firstProvider = await this._pickProvider();
    if (!firstProvider) {
      console.log('[Summaries] No LLM provider reachable — skipping');
      return 0;
    }

    this._running = true;
    this._restartPending = false;
    this._preemptRequested = false;

    try {
      const chats = this._db.getChatStats();
      /** Chats that still have at least one unsummarized thread */
      const workQueue = [];
      for (const { chatJid, chatName } of chats) {
        const timestamps = this._db.getMessageTimestampsForChat(chatJid);
        if (timestamps.length === 0) continue;
        const threads = segmentIntoThreads(timestamps);
        if (threads.length === 0) continue;
        const summarizedStarts = this._db.getSummarizedThreadStarts(chatJid);
        const pendingThreadStarts = threads
          .filter(t => !summarizedStarts.has(t[0].timestamp))
          .map(t => ({ start: t[0].timestamp, end: t[t.length - 1].timestamp }));
        if (pendingThreadStarts.length === 0) continue;
        workQueue.push({ chatJid, chatName, pendingThreadStarts });
      }

      const chatMeta = new Map(chats.map((c) => [c.chatJid, c]));
      const indexScore = (chatJid) => {
        const c = chatMeta.get(chatJid);
        if (!c) return 0;
        const lm = c.lastMessageTs || 0;
        const n = Math.max(1, c.messageCount || 0);
        return lm * Math.log1p(n);
      };

      workQueue.sort((a, b) => {
        const fa = isWhatsAppLowPriorityFeed(a.chatJid) ? 1 : 0;
        const fb = isWhatsAppLowPriorityFeed(b.chatJid) ? 1 : 0;
        if (fa !== fb) return fa - fb;
        return indexScore(b.chatJid) - indexScore(a.chatJid);
      });

      const tid = getCurrentTenantId();
      const preferred = this._priorityChatJidByTenant.get(String(tid));
      if (preferred) {
        const hasPreferred = workQueue.some((w) => w.chatJid === preferred);
        if (!hasPreferred) {
          this._priorityChatJidByTenant.delete(String(tid));
        } else if (prioritizeChatFirst(workQueue, preferred)) {
          console.log(`[Summaries] User requested "${preferred}" first`);
        }
      }

      const INITIAL_PRIORITY_CHATS = 10;
      const isInitialPass = !this._initialPassDone.get(String(tid));
      let effectiveQueue = workQueue;
      if (isInitialPass && workQueue.length > INITIAL_PRIORITY_CHATS) {
        effectiveQueue = workQueue.slice(0, INITIAL_PRIORITY_CHATS);
        console.log(`[Summaries] Initial pass: indexing top ${INITIAL_PRIORITY_CHATS} of ${workQueue.length} chats first`);
      }

      const chatsTotal = effectiveQueue.length;
      let totalGenerated = 0;

      if (chatsTotal === 0) {
        console.log('[Summaries] All thread summaries up to date');
        this._onProgress?.({ phase: 'summary', done: true, chatsTotal: 0 });
        return 0;
      }

      this._onProgress?.({
        phase: 'summary',
        started: true,
        chatsTotal,
        provider: `${firstProvider.name}/${firstProvider.model}`,
      });

      let chatIndex = 0;
      let clearedPreferred = false;
      summaryPass: for (const { chatJid, chatName, pendingThreadStarts } of effectiveQueue) {
        if (this._preemptRequested) {
          this._preemptRequested = false;
          this._restartPending = true;
          console.log('[Summaries] Preempted before chat — restarting with updated priority');
          break summaryPass;
        }
        chatIndex += 1;
        const pendingCount = pendingThreadStarts.length;
        console.log(`[Summaries] ${chatName || chatJid}: ${pendingCount} unsummarized threads (${chatIndex}/${chatsTotal} chats)`);

        this._onProgress?.({
          phase: 'summary',
          chatJid,
          chatName: chatName || chatJid,
          chatIndex,
          chatsTotal,
          threadsTotal: pendingCount,
          threadsDone: 0,
          active: true,
        });

        let completed = 0;
        let consecutiveFailures = 0;

        for (let batchStart = 0; batchStart < pendingCount; ) {
          if (this._preemptRequested) {
            this._preemptRequested = false;
            this._restartPending = true;
            console.log('[Summaries] Preempted between thread batches — restarting with updated priority');
            break summaryPass;
          }
          const activeProvider = await this._pickProvider();
          if (!activeProvider) {
            console.log('[Summaries] Provider became unavailable — pausing');
            break;
          }

          const isLocal = this._isLocal(activeProvider);
          const smallLocal = isLocal && isSmallLocalModel(activeProvider.model);
          const chunkSize = isLocal ? SUMMARY_CHUNK_LOCAL : SUMMARY_CHUNK_CLOUD;
          const delayMs = isLocal ? (smallLocal ? DELAY_LOCAL_SMALL_MS : DELAY_LOCAL_MS) : getCloudBatchDelayMs(isLocal);
          const keyCount = activeProvider._keys?.length ?? (isLocal ? 1 : DEFAULT_CONCURRENCY);
          const concurrency = getSummaryThreadConcurrency(isLocal, keyCount, activeProvider.model);

          if (batchStart === 0) {
            console.log(`[Summaries] Using ${activeProvider.name}/${activeProvider.model} — concurrency ${concurrency}`);
          }

          if (consecutiveFailures >= 5) {
            console.log(`[Summaries] Stopping chat after ${consecutiveFailures} consecutive failures`);
            break;
          }

          const batchSpecs = pendingThreadStarts.slice(batchStart, batchStart + concurrency);
          const batchThreads = batchSpecs.map(spec =>
            this._db.getMessagesByTimeRange(chatJid, spec.start, spec.end),
          ).filter(t => t.length > 0);

          const results = await Promise.allSettled(
            batchThreads.map(thread => this._summariseThread(activeProvider, thread, chatJid, chatName, chunkSize))
          );

          let batchSuccesses = 0;
          for (const result of results) {
            completed++;
            if (result.status === 'fulfilled' && result.value) {
              totalGenerated++;
              batchSuccesses++;
            }
          }
          if (batchSuccesses > 0) {
            consecutiveFailures = 0;
          } else {
            consecutiveFailures++;
          }

          this._onProgress?.({
            phase: 'summary',
            chatJid,
            chatName: chatName || chatJid,
            chatIndex,
            chatsTotal,
            threadsTotal: pendingCount,
            threadsDone: completed,
            active: true,
          });

          batchStart += concurrency;
          if (this._preemptRequested) {
            this._preemptRequested = false;
            this._restartPending = true;
            console.log('[Summaries] Preempted after thread batch — restarting with updated priority');
            break summaryPass;
          }
          if (batchStart < pendingCount) await sleep(delayMs);
        }

        const threadsProcessed = Math.min(completed, pendingCount);
        const chatFinished = threadsProcessed >= pendingCount;
        this._onProgress?.({
          phase: 'summary',
          chatJid,
          chatName: chatName || chatJid,
          chatIndex,
          chatsTotal,
          threadsTotal: pendingCount,
          threadsDone: threadsProcessed,
          chatComplete: chatFinished,
          active: false,
        });

        if (!clearedPreferred && preferred && chatJid === preferred) {
          this._priorityChatJidByTenant.delete(String(tid));
          clearedPreferred = true;
        }
      }

      if (totalGenerated > 0) {
        console.log(`[Summaries] Done — generated ${totalGenerated} thread summaries`);
      }
      this._onProgress?.({ phase: 'summary', done: true, chatsTotal, totalGenerated });

      if (isInitialPass) {
        this._initialPassDone.set(String(tid), true);
        if (workQueue.length > INITIAL_PRIORITY_CHATS) {
          console.log(`[Summaries] Initial priority pass done — scheduling full pass for remaining ${workQueue.length - INITIAL_PRIORITY_CHATS} chats`);
          this._restartPending = true;
        }
      }

      return totalGenerated;
    } finally {
      this._running = false;
      if (this._restartPending) {
        this._restartPending = false;
        console.log('[Summaries] Running queued pass (new messages or concurrent trigger)...');
        setTimeout(() => this.indexPendingDays(), 500);
      }
    }
  }

  async _summariseThread(provider, thread, chatJid, chatName, chunkSize) {
    const threadStart = thread[0].timestamp;
    const threadEnd = thread[thread.length - 1].timestamp;
    const timeLabel = `${formatTime(threadStart)} – ${formatTime(threadEnd)}`;
    try {
      const chunks = this._splitIntoChunks(thread, chunkSize);
      const partials = [];

      for (let i = 0; i < chunks.length; i += CHUNK_SUMMARY_CONCURRENCY) {
        const slice = chunks.slice(i, i + CHUNK_SUMMARY_CONCURRENCY);
        const batchResults = await Promise.all(
          slice.map((chunk, j) => {
            const segIndex = i + j + 1;
            const transcript = this._formatTranscript(chunk, chunk.length);
            return this._generateSummary(provider, transcript, chatName, timeLabel, {
              segmentIndex: segIndex,
              segmentTotal: chunks.length,
            });
          })
        );
        for (const s of batchResults) {
          if (s?.trim()) partials.push(s.trim());
        }
      }

      if (partials.length === 0) return false;

      let summary;
      if (partials.length === 1) {
        summary = partials[0];
      } else {
        summary = await this._mergePartialSummaries(provider, partials, chatName, timeLabel);
        if (!summary?.trim()) return false;
      }

      this._db.upsertThreadSummary({
        chatJid, chatName, threadStart, threadEnd, summary: summary.trim(), messageCount: thread.length,
      });
      const segNote = chunks.length > 1 ? `, ${chunks.length}×${chunkSize} batches` : '';
      console.log(`[Summaries] ✓ ${timeLabel} (${thread.length} msgs${segNote})`);

      const allFacts = [];
      for (let i = 0; i < chunks.length; i += CHUNK_SUMMARY_CONCURRENCY) {
        const slice = chunks.slice(i, i + CHUNK_SUMMARY_CONCURRENCY);
        const batchFacts = await Promise.all(
          slice.map((chunk) => this._collectFactsFromTranscript(provider, this._formatTranscript(chunk, chunk.length)))
        );
        for (const chunkFacts of batchFacts) allFacts.push(...chunkFacts);
      }
      const mergedFacts = this._dedupeFacts(allFacts);
      if (mergedFacts.length > 0) {
        const n = this._db.replaceThreadFacts({
          chatJid, chatName, threadStart, threadEnd, facts: mergedFacts,
        });
        if (n > 0) console.log(`[Facts] ✓ ${n} facts for thread ${threadStart}`);
      }

      return true;
    } catch (err) {
      console.error(`[Summaries] ✗ ${chatJid} ${timeLabel}:`, err.message.slice(0, 120));
    }
    return false;
  }

  _formatTranscript(messages, maxMessages) {
    return messages.slice(0, maxMessages).map((m) => {
      const d = new Date(m.timestamp * 1000);
      const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      const sender = m.sender || 'Unknown';
      const bits = [m.mediaCaption, m.mediaAiIndex].filter(Boolean);
      const text = m.text || (bits.length ? `[${m.mediaType}] ${bits.join(' · ')}` : `[${m.mediaType || 'media'}]`);
      return `[${time}] ${sender}: ${text}`;
    }).join('\n');
  }

  async _generateSummary(provider, transcript, chatName, timeLabel, segment = null) {
    const header = `Chat: ${chatName || 'Group'} | Time: ${timeLabel}\n\n`;
    let intro = SUMMARY_PROMPT;
    if (segment && segment.segmentTotal > 1) {
      intro =
        `This is segment ${segment.segmentIndex} of ${segment.segmentTotal} of ONE continuous WhatsApp thread (chronological). ` +
        'Summarize ONLY this segment; other segments will be merged into one summary later. ' +
        'Still include names, numbers, dates, topics, and tone for this slice.\n\n' +
        SUMMARY_PROMPT;
    }
    const prompt = intro + header + transcript;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await provider.chat(
          [{ role: 'user', content: prompt }],
          summaryLlmOptions({
            temperature: 0.2,
            maxTokens: segment?.segmentTotal > 1 ? 500 : 450,
          }),
        );

        return result?.trim() || null;
      } catch (err) {
        const msg = err.message || '';
        const is429 = msg.includes('429') || msg.includes('rate limit') || msg.includes('Rate limit');
        const isAbort = isAbortOrTimeoutErr(err);
        if ((is429 || isAbort) && attempt < 2) {
          const retryMatch = msg.match(/try again in ([\d.]+)s/i);
          const waitSec = is429
            ? (retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : 10 * (attempt + 1))
            : 8 * (attempt + 1);
          console.log(
            `[Summaries] ${isAbort ? 'Timeout/abort' : 'Rate limited'}, waiting ${waitSec}s (attempt ${attempt + 1}/3)`,
          );
          await sleep(waitSec * 1000);
          continue;
        }
        console.error(`[Summaries] LLM failed for ${chatName} ${timeLabel}:`, msg.slice(0, 200));
        return null;
      }
    }
    return null;
  }

  /**
   * Merge ordered partial summaries (pairwise tree) so each LLM call stays small.
   */
  async _mergePartialSummaries(provider, partials, chatName, timeLabel) {
    if (!partials.length) return null;
    let layer = [...partials];
    while (layer.length > 1) {
      const next = [];
      for (let i = 0; i < layer.length; i += 2) {
        if (i + 1 >= layer.length) {
          next.push(layer[i]);
        } else {
          const merged = await this._mergeTwoSummaries(provider, layer[i], layer[i + 1], chatName, timeLabel);
          next.push(merged || `${layer[i]}\n${layer[i + 1]}`);
        }
      }
      layer = next;
    }
    return layer[0]?.trim() || null;
  }

  async _mergeTwoSummaries(provider, a, b, chatName, timeLabel) {
    const header = `Chat: ${chatName || 'Group'} | Time: ${timeLabel}\n\n`;
    const mergePrompt =
      'Two consecutive summary fragments describe adjacent parts of the SAME WhatsApp conversation (in order). ' +
      'Merge them into 2-4 keyword-rich sentences. Keep ALL names, numbers, dates, topics, and tone. ' +
      'Remove redundancy. Do not add opinions.\n\n' +
      header +
      '--- Fragment A ---\n' +
      a +
      '\n\n--- Fragment B ---\n' +
      b;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await provider.chat(
          [{ role: 'user', content: mergePrompt }],
          summaryLlmOptions({ temperature: 0.15, maxTokens: 550 }),
        );
        return result?.trim() || null;
      } catch (err) {
        const msg = err.message || '';
        const is429 = msg.includes('429') || msg.includes('rate limit') || msg.includes('Rate limit');
        const isAbort = isAbortOrTimeoutErr(err);
        if ((is429 || isAbort) && attempt < 2) {
          const retryMatch = msg.match(/try again in ([\d.]+)s/i);
          const waitSec = is429
            ? (retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : 10 * (attempt + 1))
            : 8 * (attempt + 1);
          await sleep(waitSec * 1000);
          continue;
        }
        console.error(`[Summaries] Merge failed for ${chatName}:`, msg.slice(0, 160));
        return null;
      }
    }
    return null;
  }
}

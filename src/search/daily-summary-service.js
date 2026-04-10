// Gap between messages that defines a new conversation thread (30 minutes)
const THREAD_GAP_SECONDS = 30 * 60;
// Minimum messages for a thread to get its own summary
const MIN_THREAD_MESSAGES = 3;
// Maximum messages to include in one summary prompt
const MAX_MESSAGES_CLOUD = 200;
const MAX_MESSAGES_LOCAL = 100;
// Min delay between batches (ms) — kept small because key-rotation handles rate limits
const DELAY_CLOUD_MS = 500;
const DELAY_LOCAL_MS = 2000;
// Default concurrency when provider exposes no key count
const DEFAULT_CONCURRENCY = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatTime(ts) {
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/**
 * Splits a chronologically-sorted message array into conversation threads.
 * A new thread starts when the gap between consecutive messages exceeds gapSeconds.
 * Threads with fewer than MIN_THREAD_MESSAGES are merged into the nearest neighbour.
 */
function segmentIntoThreads(messages, gapSeconds = THREAD_GAP_SECONDS) {
  if (messages.length === 0) return [];

  const rawThreads = [];
  let current = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const gap = messages[i].timestamp - messages[i - 1].timestamp;
    if (gap > gapSeconds) {
      rawThreads.push(current);
      current = [messages[i]];
    } else {
      current.push(messages[i]);
    }
  }
  rawThreads.push(current);

  // Merge tiny threads (< MIN_THREAD_MESSAGES) into previous thread
  const threads = [];
  for (const t of rawThreads) {
    if (t.length < MIN_THREAD_MESSAGES && threads.length > 0) {
      threads[threads.length - 1].push(...t);
    } else {
      threads.push([...t]);
    }
  }

  // Edge case: first thread is tiny and nothing before it — merge into next
  if (threads.length >= 2 && threads[0].length < MIN_THREAD_MESSAGES) {
    threads[1].unshift(...threads[0]);
    threads.shift();
  }

  return threads.filter(t => t.length >= MIN_THREAD_MESSAGES);
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
  }

  setProvider(provider) {
    this._provider = provider;
    if (this._running) {
      console.log('[Summaries] Provider changed — aborting current run, will restart');
      this._aborted = true;
      this._restartPending = true;
    }
  }

  setFallbackProvider(provider) {
    this._fallback = provider;
  }

  _isLocal(provider) {
    return provider?.name === 'ollama';
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
      // Schedule a restart after the current run finishes
      this._restartPending = true;
      console.log('[Summaries] Already running — restart queued');
      return 0;
    }

    const activeProvider = await this._pickProvider();
    if (!activeProvider) {
      console.log('[Summaries] No LLM provider reachable — skipping');
      return 0;
    }

    const isLocal = this._isLocal(activeProvider);
    const maxMsgs = isLocal ? MAX_MESSAGES_LOCAL : MAX_MESSAGES_CLOUD;
    const delayMs = isLocal ? DELAY_LOCAL_MS : DELAY_CLOUD_MS;
    // Parallelise across keys: Ollama is single-threaded, cloud providers scale with key count
    const keyCount = activeProvider._keys?.length ?? (isLocal ? 1 : DEFAULT_CONCURRENCY);
    const concurrency = isLocal ? 1 : Math.max(1, keyCount);

    console.log(`[Summaries] Using ${activeProvider.name}/${activeProvider.model} — concurrency ${concurrency}, ${keyCount} key(s)`);

    this._running = true;
    this._aborted = false;
    this._restartPending = false;

    try {
      const chats = this._db.getChatStats();
      let totalGenerated = 0;

      for (const { chatJid, chatName } of chats) {
        if (this._aborted) break;

        const allMessages = this._db.getAllMessagesForChat(chatJid);
        if (allMessages.length === 0) continue;

        const threads = segmentIntoThreads(allMessages);
        if (threads.length === 0) continue;

        const summarizedStarts = this._db.getSummarizedThreadStarts(chatJid);
        const pending = threads.filter(t => !summarizedStarts.has(t[0].timestamp));

        if (pending.length === 0) continue;
        console.log(`[Summaries] ${chatName || chatJid}: ${pending.length} unsummarized threads (${threads.length} total)`);

        let completed = 0;
        let consecutiveFailures = 0;

        // Process threads in parallel batches of `concurrency`
        for (let batchStart = 0; batchStart < pending.length; batchStart += concurrency) {
          if (this._aborted) {
            console.log('[Summaries] Aborted — provider was changed');
            break;
          }
          if (consecutiveFailures >= 5) {
            console.log(`[Summaries] Stopping after ${consecutiveFailures} consecutive failures`);
            break;
          }

          const batch = pending.slice(batchStart, batchStart + concurrency);
          const results = await Promise.allSettled(
            batch.map(thread => this._summariseThread(activeProvider, thread, chatJid, chatName, maxMsgs))
          );

          for (const result of results) {
            completed++;
            if (result.status === 'fulfilled' && result.value) {
              totalGenerated++;
              consecutiveFailures = 0;
            } else {
              consecutiveFailures++;
            }
          }

          this._onProgress?.({ totalDays: pending.length, completed, chatJid });
          if (!this._aborted && batchStart + concurrency < pending.length) await sleep(delayMs);
        }
      }

      if (this._aborted) {
        console.log(`[Summaries] Run aborted after generating ${totalGenerated} thread summaries`);
      } else if (totalGenerated > 0) {
        console.log(`[Summaries] Done — generated ${totalGenerated} thread summaries`);
      } else {
        console.log('[Summaries] All thread summaries up to date');
      }
      return totalGenerated;
    } finally {
      this._running = false;
      this._aborted = false;
      // If provider was swapped while running, kick off a fresh run automatically
      if (this._restartPending) {
        this._restartPending = false;
        console.log('[Summaries] Restarting with new provider...');
        setTimeout(() => this.indexPendingDays(), 1000);
      }
    }
  }

  async _summariseThread(provider, thread, chatJid, chatName, maxMsgs) {
    const threadStart = thread[0].timestamp;
    const threadEnd = thread[thread.length - 1].timestamp;
    const timeLabel = `${formatTime(threadStart)} – ${formatTime(threadEnd)}`;
    try {
      const transcript = this._formatTranscript(thread, maxMsgs);
      const summary = await this._generateSummary(provider, transcript, chatName, timeLabel);
      if (summary) {
        this._db.upsertThreadSummary({ chatJid, chatName, threadStart, threadEnd, summary, messageCount: thread.length });
        console.log(`[Summaries] ✓ ${timeLabel} (${thread.length} msgs)`);
        return true;
      }
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
      const text = m.text || (m.mediaCaption ? `[${m.mediaType}] ${m.mediaCaption}` : `[${m.mediaType || 'media'}]`);
      return `[${time}] ${sender}: ${text}`;
    }).join('\n');
  }

  async _generateSummary(provider, transcript, chatName, timeLabel) {
    const header = `Chat: ${chatName || 'Group'} | Time: ${timeLabel}\n\n`;
    const prompt = SUMMARY_PROMPT + header + transcript;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await provider.chat([
          { role: 'user', content: prompt },
        ], { temperature: 0.2, maxTokens: 450 });

        return result?.trim() || null;
      } catch (err) {
        const msg = err.message || '';
        const is429 = msg.includes('429') || msg.includes('rate limit') || msg.includes('Rate limit');
        if (is429 && attempt < 2) {
          const retryMatch = msg.match(/try again in ([\d.]+)s/i);
          const waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 2 : 10 * (attempt + 1);
          console.log(`[Summaries] Rate limited, waiting ${waitSec}s (attempt ${attempt + 1}/3)`);
          await sleep(waitSec * 1000);
          continue;
        }
        console.error(`[Summaries] LLM failed for ${chatName} ${timeLabel}:`, msg.slice(0, 200));
        return null;
      }
    }
    return null;
  }
}

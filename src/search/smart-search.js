import Fuse from 'fuse.js';

const MAX_THREADS = 8;
const MAX_SUMMARIES_FOR_LLM = 400;
const MAX_SOURCES_RETURNED = 8;
const MAX_MSGS_FOR_SYNTHESIS = 50;
const LLM_DAY_SELECT_TIMEOUT = 12_000;
const LLM_SYNTH_TIMEOUT = 20_000;
const LLM_HEALTH_TIMEOUT = 4_000;

function formatTs(ts) {
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function race(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
}

function dedupeById(messages) {
  const seen = new Map();
  for (const m of messages) {
    if (!seen.has(m.id)) seen.set(m.id, m);
  }
  return Array.from(seen.values());
}

function toSource(m) {
  return {
    text: m.text || `[${m.mediaType || 'media'}]`,
    chatName: m.chatName || m.chatJid,
    sender: m.sender || 'Unknown',
    timestamp: m.timestamp,
    mediaType: m.mediaType || null,
  };
}

export default class SmartSearch {
  constructor(db, provider = null) {
    this._db = db;
    this._provider = provider;
  }

  setProvider(provider) { this._provider = provider; }

  /**
   * Pipeline (2 LLM calls max):
   *   1. Instant FTS + fuzzy (0ms LLM) — runs in parallel with health check
   *   2. Hierarchical day selection (1 LLM call) — runs if summaries exist
   *   3. Merge + dedupe
   *   4. Synthesis (1 LLM call) — crisp 2-3 sentence answer
   */
  async search(query, chatJid = null, mediaType = null) {
    const t0 = Date.now();

    // ── Instant search + health check in parallel ───────────────────
    const [instantRaw, llmAvailable] = await Promise.all([
      Promise.resolve(this._instantSearch(query, chatJid)),
      this._checkLlm(),
    ]);

    let instantHits = mediaType ? instantRaw.filter(m => m.mediaType === mediaType) : instantRaw;
    console.log(`[Search] Instant: ${instantHits.length} hits (${Date.now() - t0}ms)`);

    if (!llmAvailable) {
      if (instantHits.length === 0) return { answer: 'No results found. Try different keywords, or configure an AI model in Settings for smarter search.', sources: [] };
      return this._rawGroupedResult(instantHits.slice(0, 15), query);
    }

    // ── Hierarchical thread/day selection (single LLM call) ────────
    let hierarchicalHits = [];
    const threadSummaries = this._db.getAllThreadSummaries();
    const dailySummaries = threadSummaries.length === 0 ? this._db.getAllDailySummaries() : [];
    const summaries = threadSummaries.length > 0 ? threadSummaries : dailySummaries;
    const useThreads = threadSummaries.length > 0;

    if (summaries.length > 0) {
      try {
        hierarchicalHits = await race(
          useThreads
            ? this._hierarchicalThreadMessages(query, chatJid, threadSummaries)
            : this._hierarchicalDayMessages(query, chatJid, dailySummaries),
          LLM_DAY_SELECT_TIMEOUT,
        );
        if (mediaType) hierarchicalHits = hierarchicalHits.filter(m => m.mediaType === mediaType);
        console.log(`[Search] Hierarchical (${useThreads ? 'threads' : 'days'}): ${hierarchicalHits.length} msgs (${Date.now() - t0}ms)`);
      } catch (err) {
        console.log(`[Search] Hierarchical failed: ${err.message}`);
      }
    }

    // ── Merge: prefer hierarchical, supplement with instant ────────
    let allMessages;
    if (hierarchicalHits.length >= 10) {
      allMessages = dedupeById(hierarchicalHits).slice(0, MAX_MSGS_FOR_SYNTHESIS);
    } else {
      allMessages = dedupeById([...hierarchicalHits, ...instantHits])
        .slice(0, MAX_MSGS_FOR_SYNTHESIS);
    }

    console.log(`[Search] Merged: ${allMessages.length} msgs (${Date.now() - t0}ms)`);

    if (allMessages.length === 0) {
      return { answer: 'No relevant results found for this query.', sources: [] };
    }

    // ── Synthesis (single LLM call) ─────────────────────────────────
    try {
      const result = await race(this._synthesize(query, allMessages), LLM_SYNTH_TIMEOUT);
      if (result) {
        console.log(`[Search] Done in ${Date.now() - t0}ms`);
        return result;
      }
    } catch (err) {
      console.log(`[Search] Synthesis failed: ${err.message}`);
    }

    console.log(`[Search] Done in ${Date.now() - t0}ms (raw fallback)`);
    return this._rawGroupedResult(allMessages.slice(0, 15), query);
  }

  async _checkLlm() {
    try {
      return this._provider ? await race(this._provider.checkHealth(), LLM_HEALTH_TIMEOUT) : false;
    } catch { return false; }
  }

  // ──────────────────────────────────────────────────────────────────
  // Hierarchical: summaries TOC → LLM picks days → load messages
  // ──────────────────────────────────────────────────────────────────

  async _hierarchicalDayMessages(query, chatJid, allSummaries) {
    const summaries = chatJid
      ? allSummaries.filter(s => s.chatJid === chatJid)
      : allSummaries;
    if (summaries.length === 0) return [];

    const capped = summaries.slice(-MAX_SUMMARIES_FOR_LLM);
    const toc = capped.map((s, i) =>
      `[${i + 1}] ${s.chatName || s.chatJid} | ${s.date} | ${s.summary}`
    ).join('\n');

    const response = await this._provider.chat(
      [{
        role: 'user',
        content:
          'Select 3-6 days most likely to answer the query from this chat archive TOC.\n' +
          'Return ONLY a JSON array: [{"index":1},{"index":5},...]\n\n' +
          `TOC (${capped.length} days):\n${toc}\n\nQuery: "${query}"`,
      }],
      { temperature: 0.1, maxTokens: 200 },
    );

    const jsonMatch = response.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const selected = [];
    for (const item of parsed) {
      const idx = (item.index ?? item.i ?? item.idx) - 1;
      if (idx >= 0 && idx < capped.length) {
        selected.push({ chatJid: capped[idx].chatJid, date: capped[idx].date });
      }
    }

    console.log(`[Search] LLM picked ${selected.length} days`);

    let messages = [];
    for (const { chatJid: cjid, date } of selected.slice(0, MAX_DAYS)) {
      messages.push(...this._db.getMessagesForDay(cjid, date));
    }
    return messages;
  }

  // ──────────────────────────────────────────────────────────────────
  // Hierarchical: thread summaries TOC → LLM picks threads → load messages
  // ──────────────────────────────────────────────────────────────────

  async _hierarchicalThreadMessages(query, chatJid, allSummaries) {
    const summaries = chatJid
      ? allSummaries.filter(s => s.chatJid === chatJid)
      : allSummaries;
    if (summaries.length === 0) return [];

    const capped = summaries.slice(-MAX_SUMMARIES_FOR_LLM);
    const toc = capped.map((s, i) => {
      const start = formatTs(s.threadStart);
      const end = formatTs(s.threadEnd);
      return `[${i + 1}] ${s.chatName || s.chatJid} | ${start} – ${end} | ${s.messageCount} msgs | ${s.summary}`;
    }).join('\n');

    const response = await this._provider.chat(
      [{
        role: 'user',
        content:
          'Select 3-8 conversation threads most likely to answer the query from this chat archive.\n' +
          'Return ONLY a JSON array: [{"index":1},{"index":5},...]\n\n' +
          `Archive (${capped.length} threads):\n${toc}\n\nQuery: "${query}"`,
      }],
      { temperature: 0.1, maxTokens: 200 },
    );

    const jsonMatch = response.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const selected = [];
    for (const item of parsed) {
      const idx = (item.index ?? item.i ?? item.idx) - 1;
      if (idx >= 0 && idx < capped.length) {
        selected.push(capped[idx]);
      }
    }

    console.log(`[Search] LLM picked ${selected.length} threads`);

    let messages = [];
    for (const s of selected.slice(0, MAX_THREADS)) {
      messages.push(...this._db.getMessagesByTimeRange(s.chatJid, s.threadStart, s.threadEnd));
    }
    return messages;
  }

  // ──────────────────────────────────────────────────────────────────
  // Instant search (FTS + fuzzy — no LLM, <10ms)
  // ──────────────────────────────────────────────────────────────────

  _instantSearch(query, chatJid) {
    const allHits = new Map();

    try {
      for (const h of this._db.searchMessages(query, chatJid, 30)) {
        allHits.set(h.id, { ...h, text: h.text || (h.mediaCaption ? `[${h.mediaType}] ${h.mediaCaption}` : '') });
      }
    } catch (err) {
      console.error('[Search] FTS failed:', err.message);
    }

    try {
      for (const hit of this._db.searchThreadSummaries(query, chatJid, 4)) {
        for (const m of this._db.getMessagesByTimeRange(hit.chatJid, hit.threadStart, hit.threadEnd)) {
          if (!allHits.has(m.id)) allHits.set(m.id, m);
        }
      }
    } catch {}

    try {
      for (const hit of this._db.searchSummaries(query, chatJid, 4)) {
        for (const m of this._db.getMessagesForDay(hit.chatJid, hit.date)) {
          if (!allHits.has(m.id)) allHits.set(m.id, m);
        }
      }
    } catch {}

    if (allHits.size < 15) {
      for (const h of this._fuzzySearch(query, chatJid)) {
        if (!allHits.has(h.id)) allHits.set(h.id, h);
      }
    }

    return Array.from(allHits.values())
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }

  _fuzzySearch(query, chatJid) {
    const messages = this._db.getAllMessagesLight(chatJid, 5000);
    if (messages.length === 0) return [];

    const fuse = new Fuse(messages, {
      keys: [
        { name: 'text', weight: 0.7 },
        { name: 'sender', weight: 0.15 },
        { name: 'mediaCaption', weight: 0.15 },
      ],
      threshold: 0.4,
      distance: 200,
      includeScore: true,
      minMatchCharLength: 2,
    });

    return fuse.search(query, { limit: 20 }).map(r => r.item);
  }

  // ──────────────────────────────────────────────────────────────────
  // Synthesis — crisp answer + only cited sources
  // ──────────────────────────────────────────────────────────────────

  async _synthesize(query, messages) {
    const transcript = messages.map((m, i) => {
      const ts = formatTs(m.timestamp);
      const sender = m.sender || 'Unknown';
      const text = m.text || (m.mediaCaption ? `[${m.mediaType}] ${m.mediaCaption}` : `[${m.mediaType || 'media'}]`);
      return `[${i + 1}] ${sender} (${ts}): ${text}`;
    }).join('\n');

    const answer = await this._provider.chat([
      {
        role: 'system',
        content:
          'You are a WhatsApp chat search assistant.\n\n' +
          'FORMAT YOUR RESPONSE EXACTLY LIKE THIS:\n\n' +
          '**Summary**\n' +
          'Write a clear 3-5 sentence answer to the question. Name specific people, dates, and key details. ' +
          'Describe context, tone, and outcome when relevant (e.g., "heated exchange", "friendly debate", "unanimous agreement").\n\n' +
          '**Key Messages**\n' +
          'Quote 3-5 most relevant messages using their citation numbers:\n' +
          '- [4] Rahul: "exact quote or paraphrase" — why this is relevant\n' +
          '- [7] Amit: "exact quote or paraphrase" — why this is relevant\n\n' +
          'RULES:\n' +
          '- ALWAYS cite sources as [1], [2] etc. matching the message numbers provided.\n' +
          '- Focus on ANSWERING the question, not just listing messages.\n' +
          '- If the messages don\'t contain a clear answer, say so honestly.\n' +
          '- Ignore messages unrelated to the question.',
      },
      { role: 'user', content: `${transcript}\n\n---\nQuestion: ${query}` },
    ], { maxTokens: 1500 });

    if (!answer?.trim()) return null;

    const cited = new Set();
    for (const m of answer.matchAll(/\[(\d+)\]/g)) {
      const idx = parseInt(m[1], 10) - 1;
      if (idx >= 0 && idx < messages.length) cited.add(idx);
    }

    let sourceIndices;
    if (cited.size > 0) {
      sourceIndices = Array.from(cited).sort((a, b) => a - b).slice(0, MAX_SOURCES_RETURNED);
    } else {
      sourceIndices = messages.slice(0, Math.min(5, MAX_SOURCES_RETURNED)).map((_, i) => i);
    }

    return { answer, sources: sourceIndices.map(i => toSource(messages[i])) };
  }

  // ──────────────────────────────────────────────────────────────────
  // Raw fallback (no LLM)
  // ──────────────────────────────────────────────────────────────────

  _rawGroupedResult(messages, _query = '') {
    const capped = messages.slice(0, 15);
    const byDay = new Map();
    for (const m of capped) {
      const d = new Date(m.timestamp * 1000);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!byDay.has(dateStr)) byDay.set(dateStr, []);
      byDay.get(dateStr).push(m);
    }

    const lines = [];
    for (const [date, msgs] of byDay) {
      lines.push(`**${date}** (${msgs.length} messages)`);
      for (const m of msgs.slice(0, 4)) {
        const text = (m.text || `[${m.mediaType}]`).slice(0, 120);
        lines.push(`  **${m.sender || 'Unknown'}**: ${text}`);
      }
      if (msgs.length > 4) lines.push(`  _...and ${msgs.length - 4} more_`);
      lines.push('');
    }

    return { answer: lines.join('\n'), sources: capped.slice(0, MAX_SOURCES_RETURNED).map(toSource) };
  }
}

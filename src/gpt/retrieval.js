import { GPT_LIMITS, estimateTokens } from './limits.js';
import { heuristicDecompose } from './query-decomposer.js';

/** Reciprocal-rank-fusion constant from Cormack et al. (2009). */
const RRF_K = 60;
const DAY = 86_400;

export function messageBody(m) {
  const rawText = String(m?.text || '').trim();
  const isPlaceholder = !rawText || /^\[[\w\s]+\]$/.test(rawText);
  const mediaBits = [m?.mediaCaption, m?.mediaAiIndex]
    .map((x) => (x ? String(x).trim() : ''))
    .filter(Boolean);

  if (m?.mediaType || mediaBits.length || m?.hasMediaFile || m?.mediaPath) {
    const parts = [];
    if (!isPlaceholder && rawText) {
      parts.push(rawText);
    }
    for (const b of mediaBits) {
      if (!parts.includes(b)) parts.push(b);
    }
    const pathStr = String(m?.mediaPath || m?.media_path || '');
    if (pathStr) {
      const fileName = pathStr.split('/').pop();
      if (fileName && !parts.some((p) => p.includes(fileName))) {
        parts.unshift(fileName);
      }
    }
    const mediaTag = m?.mediaType ? `[${m.mediaType}]` : '[media]';
    if (parts.length) {
      return `${mediaTag} ${parts.join(' · ')}`;
    }
    return mediaTag;
  }

  return rawText || `[${m?.mediaType || 'media'}]`;
}

function shortDate(ts) {
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** One compact line per message; `[m123]` is the citation handle the model echoes back. */
export function formatMessageLine(m, { withChat = true } = {}) {
  const body = messageBody(m).replace(/\s+/g, ' ');
  const clipped = body.length > GPT_LIMITS.messageChars
    ? `${body.slice(0, GPT_LIMITS.messageChars - 1)}…`
    : body;
  const chat = withChat && m.chatName ? ` · ${m.chatName}` : '';
  return `[m${m.id}] ${shortDate(m.timestamp)}${chat} · ${m.sender || 'Unknown'}: ${clipped}`;
}

/**
 * Packs messages into a token budget, grouped by chat and in time order,
 * so the model reads conversations rather than a bag of hits.
 */
export function packMessages(messages, budgetTokens, seen = new Set()) {
  const byChat = new Map();
  let used = 0;
  let count = 0;
  for (const m of messages) {
    if (!m || seen.has(m.id)) continue;
    if (count >= GPT_LIMITS.maxMessagesInContext) break;
    const line = formatMessageLine(m, { withChat: false });
    const cost = estimateTokens(line) + 1;
    if (used + cost > budgetTokens) break;
    seen.add(m.id);
    used += cost;
    count += 1;
    const key = m.chatJid || '';
    if (!byChat.has(key)) byChat.set(key, { name: m.chatName || key, rows: [] });
    byChat.get(key).rows.push(m);
  }
  const blocks = [];
  for (const { name, rows } of byChat.values()) {
    rows.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
    blocks.push(`## ${name}\n${rows.map((r) => formatMessageLine(r, { withChat: false })).join('\n')}`);
  }
  return { text: blocks.join('\n\n'), tokens: used, count };
}

function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** Parses YYYY-MM-DD (local) to unix seconds; `end` gives the last second of that day. */
export function parseDay(value, { end = false } = {}) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const start = startOfLocalDay(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return end ? start + DAY - 1 : start;
}

/** Common relative dates in the user's question → a time window for prefetch. */
export function detectTimeRange(query, now = new Date()) {
  const q = String(query || '').toLowerCase();
  const today = startOfLocalDay(now);
  if (/\btoday\b|\btonight\b|\bthis morning\b/.test(q)) return { startTs: today, endTs: today + DAY - 1, label: 'today' };
  if (/\byesterday\b/.test(q)) return { startTs: today - DAY, endTs: today - 1, label: 'yesterday' };
  if (/\b(this|past|last) week\b|\blast 7 days\b/.test(q)) return { startTs: today - 6 * DAY, endTs: today + DAY - 1, label: 'the last 7 days' };
  if (/\b(this|past|last) month\b|\blast 30 days\b/.test(q)) return { startTs: today - 29 * DAY, endTs: today + DAY - 1, label: 'the last 30 days' };
  const iso = q.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) {
    const s = parseDay(iso[1]);
    if (s != null) return { startTs: s, endTs: s + DAY - 1, label: iso[1] };
  }
  return null;
}

export function isBroadQuery(query) {
  const q = String(query || '');
  return /\b(summar|recap|overview|what happened|what's new|whats new|catch me up|tl;?dr|highlights|update me)\w*/i.test(q)
    || /\bwhat(?:'s|\s+is|\s+are|\s+does|\s+do)\b[^\n]{0,100}\b(?:about|for)\b/i.test(q)
    || /\b(?:describe|summari[sz]e)\b[^\n]{0,80}\b(?:chat|group|conversation)\b/i.test(q)
    || /\bwhat(?:'s|\s+is|\s+are)\b[^\n]{0,80}\b(?:chat|group|conversation)\b/i.test(q);
}

/**
 * Hybrid multi-query retrieval: BM25 (FTS5) across semantic intent variants + MiniLM vectors
 * fused with RRF, with JIT on-demand media OCR indexing and modality/direction scoring.
 */
export async function hybridSearch({
  db,
  embeddings,
  query,
  chatJid = null,
  startTs = null,
  endTs = null,
  limit = 20,
  mediaIndexService = null,
  intent = null,
}) {
  const k = Math.max(limit * 2, 10);
  const ranged = startTs != null || endTs != null;

  // Resolve query decomposition / intent
  const resolvedIntent = intent || (typeof query === 'string' ? heuristicDecompose(query) : null);
  const modality = resolvedIntent?.modality || null;
  const outboundOnly = Boolean(resolvedIntent?.outboundOnly);

  // 1. Just-In-Time (JIT) On-Demand Media Indexing
  if (mediaIndexService && chatJid) {
    try {
      await mediaIndexService.indexChatMediaOnDemand(chatJid, {
        limit: (modality === 'image' || modality === 'document') ? 10 : 5,
        sender: outboundOnly ? 'You' : null,
        mediaType: modality || null,
      });
    } catch (jitErr) {
      console.warn('[HybridSearch:JIT]', jitErr.message);
    }
  }

  // 2. Build multi-query search variants (canonical + lexical + semantic expansions)
  const variants = new Set();
  if (typeof query === 'string' && query.trim()) variants.add(query.trim());
  if (resolvedIntent?.cleanedQuery) variants.add(resolvedIntent.cleanedQuery);
  if (Array.isArray(resolvedIntent?.lexicalQueries)) {
    for (const lq of resolvedIntent.lexicalQueries) if (lq) variants.add(lq);
  }
  if (Array.isArray(resolvedIntent?.semanticQueries)) {
    for (const sq of resolvedIntent.semanticQueries) if (sq) variants.add(sq);
  }
  // Cap distinct query variants to avoid query explosion
  const queryList = Array.from(variants).slice(0, 4);
  if (!queryList.length && typeof query === 'string') queryList.push(query);

  // 3. Parallel FTS5 queries across all variants
  const ftsPromises = queryList.map((q) => Promise.resolve().then(() => (ranged
    ? db.searchMessagesInRange(q, { chatJid, startTs: startTs ?? 0, endTs: endTs ?? undefined, limit: k })
    : db.searchMessages(q, chatJid, k))).catch(() => []));

  // 4. Vector search
  const vectorQuery = resolvedIntent?.cleanedQuery || (typeof query === 'string' ? query : '');
  const vecPromise = embeddings && vectorQuery
    ? embeddings.searchSimilar(vectorQuery, chatJid, k).catch(() => [])
    : Promise.resolve([]);

  const [allFtsResults, vec] = await Promise.all([
    Promise.all(ftsPromises),
    vecPromise,
  ]);

  // 4b. Structured Media Retrieval (for documents/PDFs/images/videos)
  let structuredHits = [];
  if (typeof db.getRecentMediaMessages === 'function' && (modality || resolvedIntent?.fileExt)) {
    try {
      structuredHits = db.getRecentMediaMessages({
        chatJid,
        mediaType: modality || (resolvedIntent?.fileExt ? 'document' : null),
        sender: outboundOnly ? 'You' : null,
        fileExt: resolvedIntent?.fileExt || null,
        limit: Math.min(limit, 10),
      });
    } catch (e) {
      console.warn('[HybridSearch:StructuredMedia]', e.message);
    }
  }

  // 4c. Conversation Chunk Search (session blocks)
  let chunkHits = [];
  if (typeof db.searchConversationChunksFts === 'function' && typeof query === 'string' && query.trim()) {
    try {
      chunkHits = db.searchConversationChunksFts(query.trim(), chatJid, 5);
    } catch (e) {
      console.warn('[HybridSearch:Chunks]', e.message);
    }
  }

  // 5. Reciprocal Rank Fusion (RRF) with Intent Boosts
  const score = new Map();
  const rowsById = new Map();

  for (const ftsHits of allFtsResults) {
    ftsHits.forEach((m, i) => {
      rowsById.set(m.id, m);
      const rrf = 1 / (RRF_K + i + 1);
      score.set(m.id, (score.get(m.id) || 0) + rrf);
    });
  }

  vec.forEach((v, i) => {
    const rrf = 1 / (RRF_K + i + 1);
    score.set(v.id, (score.get(v.id) || 0) + rrf);
  });

  structuredHits.forEach((m, i) => {
    rowsById.set(m.id, m);
    // If user specifically asked for "latest/recent" or a specific fileExt without text, give top priority
    const priority = (resolvedIntent?.recency === 'latest' || !queryList.some((q) => q.length > 3))
      ? (10.0 / (i + 1))
      : (1.0 / (RRF_K + i + 1));
    score.set(m.id, (score.get(m.id) || 0) + priority);
  });

  if (chunkHits.length > 0) {
    const chunkMessageIds = [];
    for (const ch of chunkHits) {
      if (Array.isArray(ch.messageIds)) {
        for (const mid of ch.messageIds) {
          if (typeof mid === 'number') chunkMessageIds.push(mid);
        }
      }
    }
    if (chunkMessageIds.length > 0 && typeof db.getMessagesByRowIds === 'function') {
      const fetched = db.getMessagesByRowIds(chunkMessageIds);
      for (const m of fetched) {
        rowsById.set(m.id, m);
        const rrf = 1.2 / RRF_K;
        score.set(m.id, (score.get(m.id) || 0) + rrf);
      }
    }
  }

  const missing = vec.map((v) => v.id).filter((id) => !rowsById.has(id));
  if (missing.length) {
    for (const m of db.getMessagesByRowIds(missing)) rowsById.set(m.id, m);
  }

  // Apply modality & direction multipliers
  for (const [id, currentScore] of score.entries()) {
    const row = rowsById.get(id);
    if (!row) continue;
    let multiplier = 1.0;
    if (modality && row.mediaType === modality) multiplier *= 1.5;
    if (outboundOnly && row.sender === 'You') multiplier *= 1.3;
    if (multiplier !== 1.0) score.set(id, currentScore * multiplier);
  }

  const ranked = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => rowsById.get(id))
    .filter((m) => m && (!ranged || (m.timestamp >= (startTs ?? 0) && m.timestamp <= (endTs ?? Infinity))))
    .slice(0, limit);

  const out = [];
  const seen = new Set();
  for (const hit of ranked) {
    const around = GPT_LIMITS.neighborRadius
      ? db.getChatNeighbors(hit.chatJid, hit.timestamp, hit.id, GPT_LIMITS.neighborRadius)
      : [];
    for (const m of [hit, ...around]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return { hits: ranked, messages: out, chunks: chunkHits, intent: resolvedIntent };
}

export function formatSummaryLine(s) {
  const when = s.date || (s.threadStart ? shortDate(s.threadStart) : '');
  const text = String(s.summary || '').replace(/\s+/g, ' ');
  const clipped = text.length > GPT_LIMITS.summaryChars ? `${text.slice(0, GPT_LIMITS.summaryChars - 1)}…` : text;
  return `- ${when} · ${s.chatName || s.chatJid}: ${clipped}`;
}

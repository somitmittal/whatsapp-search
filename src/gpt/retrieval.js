import { GPT_LIMITS, estimateTokens } from './limits.js';
import { heuristicDecompose } from './query-decomposer.js';

/** Reciprocal-rank-fusion constant from Cormack et al. (2009). */
const RRF_K = 60;
const DAY = 86_400;

function formatQuotedSuffix(m) {
  if (!m?.quotedPayload) return '';
  let q = m.quotedPayload;
  if (typeof q === 'string') {
    try { q = JSON.parse(q); } catch { return ''; }
  }
  if (!q || typeof q !== 'object') return '';
  const who = q.sender ? String(q.sender).trim() : '';
  const txt = q.text ? String(q.text).replace(/\s+/g, ' ').trim().slice(0, 80) : (q.mediaType ? `[${q.mediaType}]` : '');
  if (!who && !txt) return '';
  return ` [replying to ${who ? `${who}: ` : ''}${txt}]`;
}

export function messageBody(m) {
  const rawText = String(m?.text || '').trim();
  const isPlaceholder = !rawText || /^\[[\w\s]+\]$/.test(rawText);
  const mediaBits = [m?.mediaCaption, m?.mediaAiIndex]
    .map((x) => (x ? String(x).trim() : ''))
    .filter(Boolean);
  const quoteSuffix = formatQuotedSuffix(m);

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
      // Keep meaningful filenames (e.g. documents, PDFs, descriptive names), omit internal hex hashes
      const isRandomHex = /^[0-9a-fA-F_-]{16,}\.[a-zA-Z0-9]+$/.test(fileName || '');
      if (fileName && !isRandomHex && !parts.some((p) => p.includes(fileName))) {
        parts.unshift(fileName);
      }
    }
    const mediaTag = m?.mediaType ? `[${m.mediaType}]` : '[media]';
    if (parts.length) {
      return `${mediaTag} ${parts.join(' · ')}${quoteSuffix}`;
    }
    return `${mediaTag}${quoteSuffix}`;
  }

  return `${rawText || `[${m?.mediaType || 'media'}]`}${quoteSuffix}`;
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

const MONTH_INDEX = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const MONTH_NAME_ALT = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_DMY_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAME_ALT})(?:,?\\s+(\\d{2,4}))?\\b`, 'i');
const DATE_MDY_RE = new RegExp(`\\b(${MONTH_NAME_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{2,4}))?\\b`, 'i');

function resolveCalendarDate(dayNum, monthStr, yearStr, now) {
  const month = MONTH_INDEX[String(monthStr || '').toLowerCase()];
  if (month == null || dayNum < 1 || dayNum > 31) return null;
  let year;
  if (yearStr) {
    const rawY = Number(yearStr);
    year = rawY < 100 ? 2000 + rawY : rawY;
  } else {
    year = now.getFullYear();
    const candidate = new Date(year, month, dayNum);
    // If the month/day is more than 7 days in the future, assume the previous year.
    if (candidate.getTime() - now.getTime() > 7 * 86400 * 1000) {
      year -= 1;
    }
  }
  const d = new Date(year, month, dayNum);
  if (d.getMonth() !== month || d.getDate() !== dayNum) return null;
  const startTs = startOfLocalDay(d);
  return { startTs, endTs: startTs + DAY - 1 };
}

/** Common relative and calendar dates in the user's question → a time window for prefetch. */
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
    if (s != null) return { startTs: s, endTs: s + DAY - 1, label: iso[1], specificDate: true, matchedText: iso[0] };
  }
  const dmy = q.match(DATE_DMY_RE);
  if (dmy) {
    const resolved = resolveCalendarDate(Number(dmy[1]), dmy[2], dmy[3], now);
    if (resolved) return { ...resolved, label: dmy[0], specificDate: true, matchedText: dmy[0] };
  }
  const mdy = q.match(DATE_MDY_RE);
  if (mdy) {
    const resolved = resolveCalendarDate(Number(mdy[2]), mdy[1], mdy[3], now);
    if (resolved) return { ...resolved, label: mdy[0], specificDate: true, matchedText: mdy[0] };
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
  if (mediaIndexService) {
    try {
      if (chatJid && typeof mediaIndexService.indexChatMediaOnDemand === 'function') {
        await mediaIndexService.indexChatMediaOnDemand(chatJid, {
          limit: (modality === 'image' || modality === 'document') ? 10 : 5,
          sender: outboundOnly ? 'You' : null,
          mediaType: modality || null,
        });
      } else if (!chatJid && (modality || resolvedIntent?.fileExt) && typeof mediaIndexService.indexRecentMediaOnDemand === 'function') {
        await mediaIndexService.indexRecentMediaOnDemand({
          limit: 20,
          sender: outboundOnly ? 'You' : null,
          mediaType: modality || (resolvedIntent?.fileExt ? 'document' : null),
        });
      }
    } catch (jitErr) {
      console.warn('[HybridSearch:JIT]', jitErr.message);
    }
  }

  // 2. Build multi-query search variants (canonical + lexical + semantic expansions)
  const variants = [];
  const seenVar = new Set();
  const addVariant = (v) => {
    const s = String(v || '').trim();
    const key = s.toLowerCase();
    if (!s || seenVar.has(key)) return;
    seenVar.add(key);
    variants.push(s);
  };
  if (typeof query === 'string') addVariant(query);
  if (ranged && typeof query === 'string') {
    const dateStripped = query
      .replace(DATE_DMY_RE, ' ')
      .replace(DATE_MDY_RE, ' ')
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
      .replace(/\b(?:on|for|from|at|in)\s*$/i, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (dateStripped && dateStripped.toLowerCase() !== query.trim().toLowerCase()) {
      addVariant(dateStripped);
    }
  }
  if (resolvedIntent?.cleanedQuery) addVariant(resolvedIntent.cleanedQuery);
  if (Array.isArray(resolvedIntent?.lexicalQueries)) {
    for (const lq of resolvedIntent.lexicalQueries) addVariant(lq);
  }
  if (Array.isArray(resolvedIntent?.semanticQueries)) {
    for (const sq of resolvedIntent.semanticQueries) addVariant(sq);
  }
  // Cap distinct query variants to avoid query explosion
  const queryList = variants.slice(0, 4);
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

  // 4b. Structured Media Retrieval (for documents/PDFs/images/videos)
  const LEX_STOP = new Set(['the', 'and', 'for', 'from', 'with', 'find', 'show', 'give', 'tell', 'where', 'what', 'when', 'that', 'this', 'have', 'sent', 'received', 'shared']);
  const mediaKeywords = (resolvedIntent?.lexicalQueries || [])
    .flatMap((q) => String(q || '').toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, ' ').split(/\s+/))
    .filter((w) => w.length >= 2 && !LEX_STOP.has(w));
  const structuredMediaPromise = Promise.resolve().then(() => {
    if (typeof db.getRecentMediaMessages === 'function' && (modality || resolvedIntent?.fileExt)) {
      try {
        return db.getRecentMediaMessages({
          chatJid,
          mediaType: modality || (resolvedIntent?.fileExt ? 'document' : null),
          sender: outboundOnly ? 'You' : null,
          fileExt: resolvedIntent?.fileExt || null,
          keywords: mediaKeywords.length ? mediaKeywords : null,
          limit: Math.min(limit, 10),
        }) || [];
      } catch (e) {
        console.warn('[HybridSearch:StructuredMedia]', e.message);
      }
    }
    return [];
  });

  // 4c. Conversation Chunk Search (session blocks)
  const chunkSearchPromise = Promise.resolve().then(() => {
    if (typeof db.searchConversationChunksFts === 'function' && typeof query === 'string' && query.trim()) {
      try {
        return db.searchConversationChunksFts(query.trim(), chatJid, 5) || [];
      } catch (e) {
        console.warn('[HybridSearch:Chunks]', e.message);
      }
    }
    return [];
  });

  const [allFtsResults, vec, structuredHits, chunkHits] = await Promise.all([
    Promise.all(ftsPromises),
    vecPromise,
    structuredMediaPromise,
    chunkSearchPromise,
  ]);

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
    // Recency-only or filename/extension-only media queries get strong top priority;
    // keyword media queries still rely on lexical/OCR matching rather than dumping unrelated latest images.
    const isMediaOnlyQuery = !mediaKeywords.length;
    const priority = (isMediaOnlyQuery && (resolvedIntent?.recency === 'latest' || !queryList.some((q) => q.length > 3)))
      ? (10.0 / (i + 1))
      : (mediaKeywords.length ? (1.5 / (RRF_K + i + 1)) : (1.0 / (RRF_K + i + 1)));
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

  // Apply lexical coverage, exact-phrase, recency, modality, direction, and implicit feedback reranking
  const RERANK_STOP = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did',
    'can', 'could', 'will', 'would', 'in', 'on', 'at', 'to', 'for', 'from',
    'with', 'by', 'of', 'about', 'what', 'which', 'who', 'where', 'when', 'how',
    'check', 'find', 'show', 'tell', 'latest', 'recent', 'last', 'newest', 'me', 'my',
  ]);
  const rawQueryTokens = String(resolvedIntent?.cleanedQuery || (typeof query === 'string' ? query : ''))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !RERANK_STOP.has(w));
  const rerankTokens = [...new Set(rawQueryTokens)];
  const phraseNeedle = rerankTokens.length >= 2 ? rerankTokens.join(' ') : '';
  const rowTimestamps = [...rowsById.values()].map((r) => Number(r?.timestamp) || 0).filter((t) => t > 0);
  const maxRowTs = rowTimestamps.length ? Math.max(...rowTimestamps) : 0;
  const isLatestIntent = resolvedIntent?.recency === 'latest';

  const feedbackBoosts = (typeof db?.getImplicitBoostsForQuery === 'function' && typeof query === 'string' && query.trim())
    ? db.getImplicitBoostsForQuery(query)
    : null;

  for (const [id, currentScore] of score.entries()) {
    const row = rowsById.get(id);
    if (!row) continue;
    let multiplier = 1.0;
    if (modality && row.mediaType === modality) multiplier *= 1.5;
    if (outboundOnly && row.sender === 'You') multiplier *= 1.3;

    const hay = `${messageBody(row)} ${row.chatName || ''} ${row.sender || ''}`.toLowerCase();
    if (rerankTokens.length) {
      let matched = 0;
      for (const tok of rerankTokens) {
        if (hay.includes(tok)) matched += 1;
      }
      const coverage = matched / rerankTokens.length;
      multiplier *= (1 + 0.85 * coverage);
      if (phraseNeedle && hay.includes(phraseNeedle)) multiplier *= 1.35;
    }

    const rowTs = Number(row.timestamp) || 0;
    if (rowTs > 0 && maxRowTs > 0) {
      const ageDays = Math.max(0, (maxRowTs - rowTs) / DAY);
      const decayWeight = isLatestIntent ? 1.6 : 0.15;
      const halfLifeDays = isLatestIntent ? 14 : 180;
      multiplier *= (1 + decayWeight * Math.exp(-ageDays / halfLifeDays));
    }

    if (feedbackBoosts) {
      const chatDelta = row.chatJid ? (feedbackBoosts.chatBoosts.get(row.chatJid) || 0) : 0;
      const msgDelta = feedbackBoosts.messageBoosts.get(row.id) || 0;
      const combined = chatDelta + msgDelta;
      if (combined !== 0) {
        multiplier *= Math.max(0.45, Math.min(2.2, 1.0 + combined));
      }
    }
    if (multiplier !== 1.0) score.set(id, currentScore * multiplier);
  }

  const ranked = [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => rowsById.get(id))
    .filter((m) => m && (!ranged || (m.timestamp >= (startTs ?? 0) && m.timestamp <= (endTs ?? Infinity))))
    .slice(0, limit);

  const out = [];
  const seen = new Set();
  const directHitIds = new Set(ranked.map((h) => h?.id));
  const dedupeNeighborText = new Set();

  for (const hit of ranked) {
    if (seen.has(hit.id)) continue;
    const around = GPT_LIMITS.neighborRadius
      ? db.getChatNeighbors(hit.chatJid, hit.timestamp, hit.id, GPT_LIMITS.neighborRadius)
      : [];
    for (const m of [hit, ...around]) {
      if (seen.has(m.id)) continue;
      const isDirect = directHitIds.has(m.id);
      // Filter out redundant/boilerplate short neighbor chatter (e.g. repeated "ok", "yes", emoji)
      if (!isDirect) {
        const tNorm = String(m.text || '').trim().toLowerCase();
        if (tNorm.length > 0 && tNorm.length < 40) {
          if (dedupeNeighborText.has(tNorm)) continue;
          dedupeNeighborText.add(tNorm);
        }
      }
      seen.add(m.id);
      out.push(m);
    }
  }

  // Cap neighbor context to a focused budget (top 45 messages) while preserving all direct hits
  let finalMessages = out;
  if (out.length > 45) {
    const directHits = out.filter((m) => directHitIds.has(m.id));
    const neighbors = out.filter((m) => !directHitIds.has(m.id));
    const remainingSlots = Math.max(10, 45 - directHits.length);
    finalMessages = [...directHits, ...neighbors.slice(0, remainingSlots)].sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
    );
  }

  return { hits: ranked, messages: finalMessages, chunks: chunkHits, intent: resolvedIntent };
}

export function formatSummaryLine(s) {
  const when = s.date || (s.threadStart ? shortDate(s.threadStart) : '');
  const text = String(s.summary || '').replace(/\s+/g, ' ');
  const clipped = text.length > GPT_LIMITS.summaryChars ? `${text.slice(0, GPT_LIMITS.summaryChars - 1)}…` : text;
  return `- ${when} · ${s.chatName || s.chatJid}: ${clipped}`;
}

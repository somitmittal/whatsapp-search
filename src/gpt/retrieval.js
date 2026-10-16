import { GPT_LIMITS, estimateTokens } from './limits.js';

/** Reciprocal-rank-fusion constant from Cormack et al. (2009). */
const RRF_K = 60;
const DAY = 86_400;

export function messageBody(m) {
  const t = String(m.text || '').trim();
  if (t) return t;
  const bits = [m.mediaCaption, m.mediaAiIndex].filter((x) => x && String(x).trim());
  if (bits.length) return `[${m.mediaType || 'media'}] ${bits.join(' · ')}`;
  return `[${m.mediaType || 'media'}]`;
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
  return /\b(summar|recap|overview|what happened|what's new|whats new|catch me up|tl;?dr|highlights|update me)\w*/i.test(String(query || ''));
}

/**
 * Hybrid retrieval: BM25 (FTS5) + MiniLM vectors fused with RRF, then each top hit is
 * expanded with its neighbours so the model sees the surrounding exchange.
 */
export async function hybridSearch({ db, embeddings, query, chatJid = null, startTs = null, endTs = null, limit = 20 }) {
  const k = Math.max(limit * 2, 10);
  const ranged = startTs != null || endTs != null;
  const ftsPromise = Promise.resolve().then(() => (ranged
    ? db.searchMessagesInRange(query, { chatJid, startTs: startTs ?? 0, endTs: endTs ?? undefined, limit: k })
    : db.searchMessages(query, chatJid, k)));
  const vecPromise = embeddings
    ? embeddings.searchSimilar(query, chatJid, k).catch(() => [])
    : Promise.resolve([]);
  const [fts, vec] = await Promise.all([ftsPromise.catch(() => []), vecPromise]);

  const score = new Map();
  fts.forEach((m, i) => score.set(m.id, (score.get(m.id) || 0) + 1 / (RRF_K + i + 1)));
  vec.forEach((v, i) => score.set(v.id, (score.get(v.id) || 0) + 1 / (RRF_K + i + 1)));

  const rowsById = new Map(fts.map((m) => [m.id, m]));
  const missing = vec.map((v) => v.id).filter((id) => !rowsById.has(id));
  for (const m of db.getMessagesByRowIds(missing)) rowsById.set(m.id, m);

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
  return { hits: ranked, messages: out };
}

export function formatSummaryLine(s) {
  const when = s.date || (s.threadStart ? shortDate(s.threadStart) : '');
  const text = String(s.summary || '').replace(/\s+/g, ' ');
  const clipped = text.length > GPT_LIMITS.summaryChars ? `${text.slice(0, GPT_LIMITS.summaryChars - 1)}…` : text;
  return `- ${when} · ${s.chatName || s.chatJid}: ${clipped}`;
}

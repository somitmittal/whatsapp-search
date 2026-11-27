/**
 * ChatGPT-style saved memory ("Memory updated ✓").
 *
 * Long-term facts about THIS user (their business, preferences, devices,
 * ongoing work) are extracted from their Ask AI conversations and injected
 * into future answers. Clarifying-question replies (which chat / who / when)
 * are saved deterministically so Ask AI does not re-ask. Prompt injection is
 * query-filtered — only memories that overlap the current question are used.
 * Per-conversation chat memory (compaction) lives in conversation memory rows.
 */

export const MEMORY_SETTING = 'gpt_saved_memory';
export const MEMORY_ENABLED_SETTING = 'gpt_memory_enabled';
export const MEMORY_LIMIT = 100; // oldest entries are dropped when exceeded
export const MEMORY_PROMPT_CHAR_BUDGET = 4000;
/** Max memories injected into one Ask AI turn after relevance filtering. */
export const MEMORY_RELEVANT_LIMIT = 12;

/** Assistant replies that are asking the user to disambiguate. */
const CLARIFYING_QUESTION_RE = /\b(?:which\s+(?:chat|person|contact|one|date|day|amount|thread)|who\s+(?:do\s+you\s+mean|is\s+that|should\s+i)|(?:could|can)\s+you\s+(?:clarify|specify|confirm)|look\s+in\?|should\s+i\s+look|without\s+guessing)\b/i;

/** Stopwords shared with relevance scoring (keep small; domain terms must match). */
const MEMORY_STOP = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'as', 'at', 'by', 'for', 'from',
  'in', 'into', 'of', 'on', 'to', 'with', 'about', 'after', 'before', 'over', 'i', 'we', 'you',
  'he', 'she', 'they', 'it', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did', 'not', 'no', 'yes', 'my', 'me',
  'your', 'our', 'their', 'when', 'where', 'what', 'which', 'who', 'whom', 'how', 'user',
  'clarification', 'looking', 'look', 'said', 'reply', 'question', 'chat', 'chats', 'please',
  'thanks', 'thank', 'ok', 'okay', 'just', 'also', 'any', 'some', 'more', 'find', 'search',
]);

function readList(db) {
  try {
    const raw = db.getSetting?.(MEMORY_SETTING);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function isClarifyingQuestion(text) {
  const t = String(text || '').trim();
  if (t.length < 12 || t.length > 800) return false;
  return CLARIFYING_QUESTION_RE.test(t);
}

/** Significant tokens for memory ↔ query overlap. */
export function memoryTokens(text) {
  const out = new Set();
  const re = /[\p{L}\p{N}][\p{L}\p{N}&+'’.\u2010\u2011-]{1,}/gu;
  const raw = String(text || '');
  let m;
  while ((m = re.exec(raw))) {
    const tok = m[0].toLowerCase().replace(/^['’]+|['’]+$/g, '');
    if (tok.length < 2 || MEMORY_STOP.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

function tokensMatch(a, b) {
  if (a === b) return true;
  // Light stem for plurals / tense (booking ↔ bookings) without a full NLP stemmer.
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

/**
 * Score how useful a saved memory is for the current Ask AI query.
 * Clarification entries get a small boost when they share any token.
 */
export function scoreMemoryRelevance(entry, queryTokens) {
  if (!queryTokens?.size) return 0;
  const text = String(entry?.text || '');
  if (!text) return 0;
  const memToks = memoryTokens(text);
  if (!memToks.size) return 0;
  let overlap = 0;
  for (const t of queryTokens) {
    if (memToks.has(t)) {
      overlap += 1;
      continue;
    }
    for (const m of memToks) {
      if (tokensMatch(t, m)) {
        overlap += 1;
        break;
      }
    }
  }
  if (!overlap) return 0;
  const kindBoost = entry?.kind === 'clarification' ? 0.5 : 0;
  return overlap + kindBoost;
}

/**
 * Pick memories that actually overlap the current query (newest first among ties).
 * When `query` is empty, falls back to the previous “recent slice” behaviour.
 */
export function selectRelevantMemories(items, query = '', {
  limit = MEMORY_RELEVANT_LIMIT,
  budget = MEMORY_PROMPT_CHAR_BUDGET,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const q = String(query || '').trim();
  if (!q) {
    // No query context (legacy callers): keep the recent tail within budget.
    const recent = list.slice(-60);
    const picked = [];
    let used = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const line = `- ${recent[i].text}`;
      if (used + line.length + 1 > budget) break;
      picked.unshift(recent[i]);
      used += line.length + 1;
      if (picked.length >= limit) break;
    }
    return picked;
  }
  const qToks = memoryTokens(q);
  if (!qToks.size) return [];
  const ranked = list
    .map((entry, idx) => ({ entry, idx, score: scoreMemoryRelevance(entry, qToks) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => (b.score - a.score) || (b.idx - a.idx));
  const picked = [];
  let used = 0;
  for (const { entry } of ranked) {
    const line = `- ${entry.text}`;
    if (used + line.length + 1 > budget) continue;
    picked.push(entry);
    used += line.length + 1;
    if (picked.length >= limit) break;
  }
  return picked;
}

export function isMemoryEnabled(db) {
  return String(db.getSetting?.(MEMORY_ENABLED_SETTING) || 'on').trim().toLowerCase() !== 'off';
}

export function setMemoryEnabled(db, enabled) {
  db.setSetting(MEMORY_ENABLED_SETTING, enabled ? 'on' : 'off');
}

/** Newest-first list of { id, text, ts }. */
export function listMemory(db) {
  const list = readList(db);
  return { enabled: isMemoryEnabled(db), memories: list.reverse() };
}

/**
 * Add a memory. Dedupes case-insensitively; caps the list (drops oldest).
 * @param {{ kind?: 'fact'|'clarification' }} [opts]
 * @returns {{ added: boolean, entry: object|null, memories: object[] }}
 */
export function addMemory(db, text, opts = {}) {
  const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 500);
  if (!t) return { added: false, entry: null, memories: readList(db) };
  const list = readList(db);
  const fold = (s) => s.toLowerCase();
  if (list.some((m) => fold(m.text) === fold(t))) {
    return { added: false, entry: null, memories: list };
  }
  const kind = opts.kind === 'clarification' ? 'clarification' : 'fact';
  // micro-ids: avoid uuid import just for this; sequence is enough for a local list
  const entry = {
    id: `mem_${Date.now().toString(36)}_${list.length + 1}`,
    text: t,
    ts: Date.now(),
    kind,
  };
  list.push(entry);
  while (list.length > MEMORY_LIMIT) list.shift();
  db.setSetting(MEMORY_SETTING, JSON.stringify(list));
  return { added: true, entry, memories: list };
}

/**
 * Turn a clarifying Q + user reply into a durable third-person fact.
 * Deterministic (no LLM) so small local models still remember disambiguation.
 */
export function buildClarificationMemoryText(priorAssistantText, userText) {
  const reply = String(userText || '').trim().replace(/\s+/g, ' ').slice(0, 220);
  if (reply.length < 1) return null;
  const ask = String(priorAssistantText || '').trim().replace(/\s+/g, ' ').slice(0, 180);
  if (!ask || !isClarifyingQuestion(ask)) return null;
  return `User clarification: for "${ask}", they said "${reply}". Apply this next time instead of asking again.`;
}

/**
 * Save a clarification reply into saved memory when the prior assistant turn asked.
 * @returns {{ added: boolean, entry: object|null, memories: object[] }|null}
 */
export function saveClarificationFromTurn(db, { priorAssistantText, userText } = {}) {
  if (!isMemoryEnabled(db)) return null;
  const text = buildClarificationMemoryText(priorAssistantText, userText);
  if (!text) return null;
  return addMemory(db, text, { kind: 'clarification' });
}

export function deleteMemory(db, id) {
  const list = readList(db);
  const next = list.filter((m) => m.id !== String(id));
  if (next.length === list.length) return false;
  db.setSetting(MEMORY_SETTING, JSON.stringify(next));
  return true;
}

/**
 * Formatted block for the system prompt, or '' when none/off.
 * When `query` is set, only memories that overlap that query are included.
 * @param {{ query?: string }} [opts]
 */
export function memoryPromptBlock(db, now = new Date(), opts = {}) {
  if (!isMemoryEnabled(db)) return '';
  const query = typeof opts === 'string' ? opts : String(opts?.query || '');
  const items = selectRelevantMemories(readList(db), query);
  if (!items.length) return '';
  const lines = items.map((m) => `- ${m.text}`);
  return [
    `# Saved memory — only facts relevant to THIS question (honor these; do not re-ask settled clarifications)`,
    `# Learned ${now.toISOString().slice(0, 10)}:`,
    ...lines,
  ].join('\n');
}

/**
 * Cheap gate before spending a model call on extraction.
 * Option A: Only consider saving memory when the user explicitly states a durable
 * personal/business fact, preference, or asks to remember something — avoids
 * wasting a 2nd LLM call per turn and prevents saving chat answers as user facts.
 * Clarification replies are handled separately via saveClarificationFromTurn (no LLM).
 */
const EXPLICIT_USER_FACT_RE = /\b(?:remember\s+(?:that|this)|my\s+(?:name|business|company|shop|salon|site|role|team|email|phone|preference|address|laptop|device|computer)|my\s+[a-z0-9_-]{2,24}\s+(?:is|are)\b|i\s+(?:am|work|own|run|prefer|always|usually|live)\b|we\s+(?:are|use|prefer|run|own)\b|call\s+me\b)\b/i;

export function shouldConsiderMemory(userText, answerText, { priorAssistantText } = {}) {
  const u = String(userText || '').trim();
  const a = String(answerText || '').trim();
  if (priorAssistantText && isClarifyingQuestion(priorAssistantText) && u.length >= 1) {
    // Clarifications are saved deterministically; skip the extra LLM extract.
    return false;
  }
  if (u.length < 12 || a.length < 12) return false;
  return EXPLICIT_USER_FACT_RE.test(u);
}

/**
 * One provider call: decides whether this exchange says something durable
 * about the user and distills it to a single line. Returns the text or null.
 * Falls back to whole-output parsing when the model ignores the JSON format.
 */
export async function extractMemoryFromExchange(provider, { userText, answerText }) {
  if (!provider || typeof provider.chat !== 'function') return null;
  const raw = await provider.chat(
    [
      {
        role: 'system',
        content: 'You manage long-term memory for a personal assistant. Given one exchange, decide if the USER '
          + 'revealed a durable fact worth remembering for weeks (who they are, their business, work, team, '
          + 'devices, preferences, ongoing projects/prerequisites like "waiting for GST number", or a '
          + 'disambiguation like which chat/person/date to use for a recurring topic). Do NOT save '
          + 'transient chit-chat, facts about other people that only matter in that chat, and do not save '
          + 'assistant opinions. Reply ONLY strict JSON, one line: {"memory":"<fact, third person, under 200 chars>"} '
          + 'or {"memory":null}. No markdown.',
      },
      {
        role: 'user',
        content: `User: ${userText}\n\nAssistant: ${answerText}`,
      },
    ],
    { maxTokens: 160, temperature: 0 },
  );
  const text = String(raw || '').trim();
  if (!text) return null;
  // Small local models sometimes echo field labels/quotes from the prompt — strip them.
  const clean = (s) => s
    .replace(/^<fact[^>]*>\s*:?\s*/i, '')
    .replace(/^["'`\s]+|["'`\s]+$/g, '')
    .trim();
  try {
    const jsonPart = text.match(/\{[\s\S]*\}/)?.[0] || text;
    const parsed = JSON.parse(jsonPart);
    const mem = typeof parsed?.memory === 'string' ? clean(parsed.memory) : '';
    if (!mem || mem.toLowerCase() === 'null') return null;
    return mem.slice(0, 500);
  } catch {
    return null;
  }
}

/** Background save used by GptService after a completed turn. */
export function saveMemorySafely(db, text, onChange) {
  const res = addMemory(db, text);
  try { onChange?.(res); } catch { /* callback */ }
  return res;
}

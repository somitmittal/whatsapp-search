/**
 * ChatGPT-style saved memory ("Memory updated ✓").
 *
 * Long-term facts about THIS user (their business, preferences, devices,
 * ongoing work) are extracted from their Ask AI conversations and injected
 * into every future answer. Per-conversation chat memory (compaction) lives
 * in conversation memory rows; this is the profile-level memory list.
 */

export const MEMORY_SETTING = 'gpt_saved_memory';
export const MEMORY_ENABLED_SETTING = 'gpt_memory_enabled';
export const MEMORY_LIMIT = 100; // oldest entries are dropped when exceeded
export const MEMORY_PROMPT_CHAR_BUDGET = 4000;

function readList(db) {
  try {
    const raw = db.getSetting?.(MEMORY_SETTING);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
 * @returns {{ added: boolean, entry: object|null, memories: object[] }}
 */
export function addMemory(db, text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 500);
  if (!t) return { added: false, entry: null, memories: readList(db) };
  const list = readList(db);
  const fold = (s) => s.toLowerCase();
  if (list.some((m) => fold(m.text) === fold(t))) {
    return { added: false, entry: null, memories: list };
  }
  // micro-ids: avoid uuid import just for this; sequence is enough for a local list
  const entry = { id: `mem_${Date.now().toString(36)}_${list.length + 1}`, text: t, ts: Date.now() };
  list.push(entry);
  while (list.length > MEMORY_LIMIT) list.shift();
  db.setSetting(MEMORY_SETTING, JSON.stringify(list));
  return { added: true, entry, memories: list };
}

export function deleteMemory(db, id) {
  const list = readList(db);
  const next = list.filter((m) => m.id !== String(id));
  if (next.length === list.length) return false;
  db.setSetting(MEMORY_SETTING, JSON.stringify(next));
  return true;
}

/** Formatted block for the system prompt, or '' when none/off. */
export function memoryPromptBlock(db, now = new Date()) {
  if (!isMemoryEnabled(db)) return '';
  const items = readList(db).slice(-60); // recency-kept entries
  if (!items.length) return '';
  // Newest last so ordering reads naturally; keep within the char budget.
  let lines = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const line = `- ${items[i].text}`;
    if (used + line.length + 1 > MEMORY_PROMPT_CHAR_BUDGET) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  return [
    `# Saved memory — durable facts about THIS user (honor these in every answer)`,
    `# Learned ${now.toISOString().slice(0, 10)} over the last 30 days:`,
    ...lines,
  ].join('\n');
}

/**
 * Cheap gate before spending a model call on extraction.
 * Only real exchanges can reveal durable facts.
 */
export function shouldConsiderMemory(userText, answerText) {
  const u = String(userText || '').trim();
  const a = String(answerText || '').trim();
  return u.length >= 12 && a.length >= 12;
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
          + 'devices, preferences, ongoing projects/prerequisites like "waiting for GST number"). Do NOT save '
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
    // Model answered in prose; accept a short declarative line as the memory.
    if (text.length <= 300 && /^(the user|user|they|he|she|we)/i.test(text)) {
      return text.slice(0, 500);
    }
    return null;
  }
}

/** Background save used by GptService after a completed turn. */
export function saveMemorySafely(db, text, onChange) {
  const res = addMemory(db, text);
  try { onChange?.(res); } catch { /* callback */ }
  return res;
}

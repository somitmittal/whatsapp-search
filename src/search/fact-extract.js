/**
 * Structured fact extraction for WhatsApp threads (JSON array from LLM).
 */

const FACT_EXTRACTION_BASE = `You extract searchable structured facts from a WhatsApp conversation transcript.

Output ONLY a valid JSON array (no markdown fences, no commentary). Max 30 objects.

Each object MUST have:
- "type": one of: "plan", "recommendation", "decision", "conflict", "shared_content", "payment", "meeting", "question", "appointment", "order", "lead", "site_visit", "delivery", "complaint", "prescription", "other"

Add fields depending on type (use short strings, real names from the chat):
- plan: topic, dates_mentioned, people (array of strings), details
- recommendation: item, by, context
- decision: about, outcome, by
- conflict: topic, people (array), intensity ("low"|"medium"|"high"), summary
- shared_content: what, shared_by
- payment: amount, currency, context
- meeting: when, topic, attendees (array)
- question: text, asked_by
- other: summary, entities (array of strings)

Also add "search_text" on EVERY object: one line of space-separated keywords (names, places, topics) for full-text search.

Example:
[{"type":"conflict","topic":"trip budget","people":["Ravi","Priya"],"intensity":"high","summary":"argued about Goa costs","search_text":"Ravi Priya Goa budget argument heated"},{"type":"recommendation","item":"Smoke House Deli","by":"Ali","context":"anniversary","search_text":"Ali Smoke House Deli anniversary restaurant"}]

Transcript:
`;

/** @deprecated use buildFactExtractionPrompt */
export const FACT_EXTRACTION_PROMPT = FACT_EXTRACTION_BASE;

/**
 * @param {string} [profileAddon]
 * @returns {string}
 */
export function buildFactExtractionPrompt(profileAddon = '') {
  const addon = String(profileAddon || '').trim();
  if (!addon) return FACT_EXTRACTION_BASE;
  return `${FACT_EXTRACTION_BASE.replace(
    'Transcript:\n',
    `${addon}\n\nTranscript:\n`,
  )}`;
}

/** Parse LLM response into fact objects; returns [] on failure. */
export function parseFactsFromLlmResponse(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr.filter(f => f && typeof f === 'object' && f.type);
  } catch {
    return [];
  }
}

/** @deprecated use parseFactsFromLlmResponse */
export const parseFactsFromLlm = parseFactsFromLlmResponse;

/** Flatten fact object into FTS-friendly text (cap length). */
export function buildSearchText(fact) {
  const parts = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') parts.push(v);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(fact);
  const s = [...new Set(parts.join(' ').split(/\s+/))].join(' ').trim();
  return s.slice(0, 4000);
}

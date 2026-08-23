/**
 * Grounding guards for LLM output.
 *
 * Every name, number and quote the model produces must already exist in the
 * transcript it was given. Small local models (llama3.2:3b and friends) happily
 * "helpfully" expand an unfamiliar token — turning BSE into "Bollywood Stock
 * Exchange" — so prompt rules alone are not enough. These helpers verify the
 * output afterwards and strip whatever cannot be traced back to the chat.
 */

/** Prompt block shared by every generation call that reads user chat content. */
export const GROUNDING_PROMPT_RULES = [
  'GROUNDING (most important rules — never break these):',
  '- Use ONLY the messages provided below. Treat them as your entire knowledge.',
  '- Never add a name, company, ticker, product, place, number or date that is not written in the messages.',
  '- Never expand, translate or explain an abbreviation, acronym or short form. Copy it exactly as written.',
  '- Copy spellings exactly, even when a word looks misspelt, unfamiliar or wrong.',
  '- Never guess what an unknown word refers to. If you do not know, leave it as-is.',
  '- If the messages do not answer the question, say so plainly instead of filling the gap.',
].join('\n');

/** Note appended when the verifier had to remove something. */
export const UNGROUNDED_NOTICE =
  '_Some details were removed because they were not found in your chats._';

/** Returned instead of an answer when nothing survived verification. */
export const NO_GROUNDED_ANSWER =
  'I could not answer this from your chats without guessing, so no answer is shown.';

const WORD_RE = /[\p{L}][\p{L}\p{N}&+'’.-]*/gu;
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}&+'’.-]*/gu;
const LIST_ITEM_RE = /^(\s*(?:[-*•]|\d+[.)])\s+)(.*)$/;

/**
 * Words that carry no entity meaning, so an absence from the transcript says
 * nothing about hallucination. Kept deliberately small: anything domain
 * specific must come from the chat.
 */
const NON_ENTITY_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'because', 'as', 'at', 'by', 'for',
  'from', 'in', 'into', 'of', 'on', 'to', 'with', 'without', 'about', 'after', 'before', 'over',
  'i', 'we', 'you', 'he', 'she', 'they', 'it', 'this', 'that', 'these', 'those', 'there', 'here',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did',
  'no', 'not', 'yes', 'none', 'also', 'however', 'additionally', 'overall', 'finally', 'plus',
  'summary', 'summaries', 'key', 'message', 'messages', 'chat', 'chats', 'group', 'groups',
  'unknown', 'note', 'notes', 'sources', 'source', 'answer', 'question', 'questions', 'details',
  'following', 'other', 'others', 'more', 'most', 'some', 'many', 'few', 'several', 'both',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'am', 'pm', 'today', 'tomorrow', 'yesterday',
]);

/** Characters that can sit between a sentence break and its first word. */
const LEADING_PUNCT = /["'“”‘’([{*_#\-•>]/;
const SENTENCE_BREAK = /[.!?:;\n]/;

/** Lowercase, drop punctuation and diacritic-free-ish comparison key for one word. */
export function normalizeToken(token) {
  return String(token || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Lowercase, punctuation-collapsed form used for phrase containment checks. */
export function normalizePhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * @typedef {{ tokens: Set<string>, paddedText: string }} GroundingIndex
 */

/**
 * Build a lookup over the exact text the model was shown.
 * @param {string} sourceText
 * @returns {GroundingIndex}
 */
export function buildGroundingIndex(sourceText) {
  const text = String(sourceText || '');
  const tokens = new Set();
  for (const m of text.matchAll(TOKEN_RE)) {
    const t = normalizeToken(m[0]);
    if (!t) continue;
    tokens.add(t);
    // "Rahul's" / "reports" should match "Rahul" / "report".
    if (t.length > 3 && t.endsWith('s')) tokens.add(t.slice(0, -1));
  }
  return { tokens, paddedText: ` ${normalizePhrase(text)} ` };
}

/**
 * True when a single word can be traced to the transcript. Pure numbers are
 * allowed because counts ("3 people") are legitimately derived.
 * @param {string} token
 * @param {GroundingIndex} index
 */
export function isTokenGrounded(token, index) {
  const t = normalizeToken(token);
  if (!t) return true;
  if (/^\d+$/.test(t)) return true;
  if (NON_ENTITY_WORDS.has(t)) return true;
  if (index.tokens.has(t)) return true;
  if (t.length > 3 && t.endsWith('s') && index.tokens.has(t.slice(0, -1))) return true;
  return false;
}

/**
 * True when the whole phrase appears verbatim (modulo punctuation/case).
 * @param {string} phrase
 * @param {GroundingIndex} index
 */
export function isPhraseGrounded(phrase, index) {
  const p = normalizePhrase(phrase);
  if (!p) return true;
  return index.paddedText.includes(` ${p} `);
}

function startsSentence(text, wordIndex) {
  for (let i = wordIndex - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') continue;
    if (SENTENCE_BREAK.test(ch)) return true;
    if (LEADING_PUNCT.test(ch)) continue;
    return false;
  }
  return true;
}

/**
 * Words that look like they name something: capitalised mid-sentence, or all
 * caps anywhere. Sentence-initial capitals are grammar, not evidence, so they
 * are skipped unless the caller says the text is a list item (which has no
 * sentence structure to blame the capital on).
 *
 * @param {string} text
 * @param {{ skipSentenceStart?: boolean }} [opts]
 * @returns {string[]}
 */
export function entityWords(text, { skipSentenceStart = true } = {}) {
  const src = String(text || '');
  const out = [];
  for (const m of src.matchAll(WORD_RE)) {
    const word = m[0];
    const first = word[0];
    const isAllCaps = word.length >= 2 && word === word.toUpperCase() && word !== word.toLowerCase();
    const isCapitalised = first === first.toUpperCase() && first !== first.toLowerCase();
    if (!isCapitalised && !isAllCaps) continue;
    if (skipSentenceStart && !isAllCaps && startsSentence(src, m.index)) continue;
    const t = normalizeToken(word);
    if (!t || NON_ENTITY_WORDS.has(t)) continue;
    out.push(word);
  }
  return out;
}

function ungroundedWords(text, index, opts) {
  return entityWords(text, opts).filter((w) => !isTokenGrounded(w, index));
}

/**
 * Remove parenthetical glosses the model invented, e.g. `BSE (Bollywood Stock
 * Exchange)` → `BSE`. A parenthetical survives if it appears in the transcript
 * or contains no invented entity.
 */
function stripUngroundedParentheticals(line, index, removed) {
  return line.replace(/\s*\(([^()]*)\)/g, (match, inner) => {
    if (isPhraseGrounded(inner, index)) return match;
    const bad = ungroundedWords(inner, index, { skipSentenceStart: false });
    if (bad.length === 0) return match;
    removed.push(inner.trim());
    return '';
  });
}

function splitSentences(text) {
  const parts = String(text || '').match(/[^.!?]+[.!?]*\s*/g);
  return parts && parts.length ? parts : [String(text || '')];
}

function dropUngroundedSentences(line, index, removed) {
  const sentences = splitSentences(line);
  const kept = [];
  for (const s of sentences) {
    const bad = ungroundedWords(s, index, { skipSentenceStart: true });
    if (bad.length) {
      removed.push(...bad);
      continue;
    }
    kept.push(s);
  }
  return kept.join('').trimEnd();
}

/**
 * Strip anything in the answer that is not supported by the transcript.
 *
 * @param {string} answer
 * @param {string} sourceText the transcript exactly as it was sent to the model
 * @returns {{ text: string, removed: string[] }}
 */
export function enforceGroundedAnswer(answer, sourceText) {
  const index = buildGroundingIndex(sourceText);
  const removed = [];
  const kept = [];

  for (const rawLine of String(answer || '').split('\n')) {
    const line = stripUngroundedParentheticals(rawLine, index, removed);
    const listMatch = line.match(LIST_ITEM_RE);

    if (listMatch) {
      const [, marker, content] = listMatch;
      const bad = ungroundedWords(content, index, { skipSentenceStart: false });
      if (bad.length) {
        removed.push(...bad);
        continue;
      }
      kept.push(`${marker}${content}`);
      continue;
    }

    if (!line.trim()) {
      kept.push(line);
      continue;
    }

    const prose = dropUngroundedSentences(line, index, removed);
    if (prose.trim()) kept.push(prose);
  }

  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

/**
 * Drop bullets whose quoted text is not verbatim in the message they cite.
 * `citedTexts[0]` backs citation `[1]`.
 *
 * @param {string} answer
 * @param {string[]} citedTexts
 * @returns {{ text: string, removed: string[] }}
 */
export function dropUnsupportedQuotes(answer, citedTexts) {
  const removed = [];
  const indexes = (citedTexts || []).map((t) => buildGroundingIndex(t));
  const kept = [];

  for (const line of String(answer || '').split('\n')) {
    const citation = line.match(/\[(\d+)\]/);
    const quotes = [...line.matchAll(/["“]([^"”]{4,})["”]/g)].map((m) => m[1]);
    if (!citation || quotes.length === 0) {
      kept.push(line);
      continue;
    }

    const idx = parseInt(citation[1], 10) - 1;
    const target = indexes[idx];
    if (!target) {
      removed.push(citation[0]);
      continue;
    }

    const unsupported = quotes.filter((q) => !isPhraseGrounded(q, target));
    if (unsupported.length) {
      removed.push(...unsupported);
      continue;
    }
    kept.push(line);
  }

  return { text: kept.join('\n'), removed };
}

/**
 * Full verification pass for a synthesised answer.
 *
 * @param {string} answer
 * @param {{ transcript: string, messageTexts?: string[] }} context
 * @returns {{ text: string, removed: string[], empty: boolean }}
 */
export function groundAnswer(answer, { transcript, messageTexts = [] }) {
  const quoted = dropUnsupportedQuotes(answer, messageTexts);
  const grounded = enforceGroundedAnswer(quoted.text, transcript);
  const removed = [...quoted.removed, ...grounded.removed];
  const hasContent = /[\p{L}\p{N}]/u.test(grounded.text.replace(/\*\*[^*]*\*\*/g, ''));

  if (!hasContent) {
    return { text: NO_GROUNDED_ANSWER, removed, empty: true };
  }
  const text = removed.length ? `${grounded.text}\n\n${UNGROUNDED_NOTICE}` : grounded.text;
  return { text, removed, empty: false };
}

/**
 * Fields whose values must be copied from the chat verbatim. Free-text fields
 * like `summary` or `context` are paraphrases and are checked word by word
 * instead of being required to match as a phrase.
 */
const VERBATIM_FACT_FIELDS = new Set([
  'item', 'by', 'people', 'attendees', 'shared_by', 'asked_by', 'patient_name',
  'customer_name', 'buyer_name', 'product', 'medicine', 'property', 'order_id',
  'amount', 'currency', 'dosage', 'quantity', 'courier', 'pincode', 'address',
]);

function factValueGrounded(value, index) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.every((v) => factValueGrounded(v, index));
  if (typeof value === 'number') return index.tokens.has(normalizeToken(String(value)));
  if (typeof value !== 'string') return true;
  return isPhraseGrounded(value, index);
}

/**
 * Drop facts that name something absent from the transcript, and strip invented
 * keywords out of `search_text` so they cannot pull up wrong search hits.
 *
 * @param {object[]} facts
 * @param {string} sourceText
 * @returns {object[]}
 */
export function filterGroundedFacts(facts, sourceText) {
  if (!Array.isArray(facts) || facts.length === 0) return [];
  const index = buildGroundingIndex(sourceText);
  const out = [];

  for (const fact of facts) {
    if (!fact || typeof fact !== 'object') continue;

    let ok = true;
    for (const [field, value] of Object.entries(fact)) {
      if (field === 'search_text') continue;
      if (VERBATIM_FACT_FIELDS.has(field)) {
        if (!factValueGrounded(value, index)) { ok = false; break; }
      } else if (typeof value === 'string') {
        if (ungroundedWords(value, index, { skipSentenceStart: false }).length) { ok = false; break; }
      }
    }
    if (!ok) continue;

    if (typeof fact.search_text === 'string') {
      const cleaned = fact.search_text
        .split(/\s+/)
        .filter((w) => w && isTokenGrounded(w, index))
        .join(' ');
      out.push({ ...fact, search_text: cleaned });
    } else {
      out.push(fact);
    }
  }

  return out;
}

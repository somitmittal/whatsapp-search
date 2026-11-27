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
  '- Use ONLY the WhatsApp messages and any tool results (including Web search) provided below. Treat those as your entire knowledge.',
  '- Never add a name, company, ticker, product, place, number or date that is not written in the messages or tool results.',
  '- Never invent public facts, bus/train/flight schedules, prices, or operators that are not listed in a Web search tool result.',
  '- Never claim you searched the web unless a Web search tool result is already in context (or you are about to CALL web_search).',
  '- Never expand, translate or explain an abbreviation, acronym or short form. Copy it exactly as written.',
  '- Copy spellings exactly, even when a word looks misspelt, unfamiliar or wrong.',
  '- Never guess what an unknown word refers to. If you do not know, leave it as-is.',
  '- NEVER invent, guess, or assume relationships, family roles, or titles between people (such as wife, husband, spouse, brother, sister, father, mother, son, daughter, cousin, friend, colleague, boss, manager, owner) unless that exact relationship is explicitly written in the messages.',
  '- Before asking a clarifying question, check Saved memory for a prior clarification that already settles which chat, person, date, or amount — apply it silently instead of re-asking.',
  '- If the messages do not fully answer the question and Saved memory does not settle it, ask ONE short clarifying question (which chat, who, which date/amount) instead of guessing or inventing details — or CALL web_search when the user asked for live/public info.',
  '- Do not hedge with only "I am not sure" or "I don\'t know" — either answer from the messages/tool results with citations, or ask what to look up next.',
  '- Never invent amounts, dates, or relationships. Numbers and family/work roles must appear in the messages themselves, not only in the user\'s question.',
  '- SITUATIONAL CONVERSATIONS: When asked situational or immediate questions (e.g. "where are we heading?", "where are we meeting?", "did you leave?", "what time?"), answer from the active recent messages. Do not pull historical keyword matches from unrelated chats.',
].join('\n');

/** Note appended when the verifier had to remove something. */
export const UNGROUNDED_NOTICE =
  '_Some details were removed because they were not found in your chats or tool results._';

/** Returned instead of an answer when nothing survived verification. */
export const NO_GROUNDED_ANSWER =
  'I could not find enough in your chats to answer that without guessing. Which chat or person should I look in?';

const WORD_RE = /[\p{L}][\p{L}\p{N}&+'’.\u2010\u2011-]*/gu;
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}&+'’.\u2010\u2011-]*/gu;
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
  'whatsapp', 'phone', 'mobile', 'media', 'file', 'files', 'image', 'images', 'video', 'videos',
  'audio', 'document', 'documents', 'photo', 'photos', 'screenshot', 'screenshots', 'receipt',
  'receipts', 'pdf', 'pdfs', 'link', 'links', 'url', 'urls', 'app', 'apps', 'text', 'caption',
  'captions', 'history', 'scroll', 'search', 'terms', 'conditions', 't&c', 'tnc', 'tc',
  'match', 'matches', 'zero', 'found', 'exist', 'exists', 'bhaiyao', 'bhaiya',
  'ocr', 'menu', 'menus', 'ad', 'ads', 'order', 'orders', 'poster', 'posters',
  'quotation', 'quote', 'quotes', 'warranty', 'warranties', 'replacement', 'gst', 'applicable',
  'extra', 'application', 'charge', 'charges', 'price', 'prices', 'total', 'results', 'result',
  'mention', 'mentions', 'mentioned', 'conversation', 'conversations', 'individuals', 'none',
  'location', 'locations', 'company', 'companies', 'job', 'jobs', 'role', 'roles', 'reference',
  'references', 'date', 'dates', 'time', 'times', 'sender', 'senders', 'shared', 'share',
  'status', 'type', 'types', 'category', 'categories', 'item', 'items', 'option', 'options',
  'tier', 'tiers', 'duration', 'amount', 'amounts', 'rate', 'rates', 'cost', 'costs',
  'feature', 'features', 'brand', 'title', 'titles', 'address', 'addresses', 'description',
  'information', 'overview', 'listed', 'list', 'posted', 'post', 'author', 'timing',
  'point', 'points', 'discussion', 'discussions', 'agreed', 'clarified', 'confirmed',
  'concern', 'concerned', 'delayed', 'issue', 'issues', 'meeting', 'plan', 'plans',
  'schedule', 'update', 'updates', 'treatment', 'appointment', 'matter',
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

/** Split camelCase and dot/hyphen/underscore compounds (e.g. "GlossFinish" -> ["Gloss", "Finish"], "V2_Abhishek.pdf" -> ["V2", "Abhishek", "pdf"]). */
function compoundSubtokens(rawWord) {
  const spaced = String(rawWord || '')
    .replace(/([a-z\p{Ll}])([A-Z\p{Lu}])/gu, '$1 $2')
    .replace(/[._\u2010\u2011-]+/g, ' ');
  return spaced.split(/\s+/).map(normalizeToken).filter(Boolean);
}

/**
 * Build a lookup over the exact text the model was shown.
 * @param {string} sourceText
 * @returns {GroundingIndex}
 */
export function buildGroundingIndex(sourceText) {
  const text = String(sourceText || '');
  const tokens = new Set();
  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[0];
    const t = normalizeToken(raw);
    if (!t) continue;
    tokens.add(t);
    // "Rahul's" / "reports" should match "Rahul" / "report".
    if (t.length > 3 && t.endsWith('s')) tokens.add(t.slice(0, -1));
    for (const sub of compoundSubtokens(raw)) {
      if (sub.length >= 2) {
        tokens.add(sub);
        if (sub.length > 3 && sub.endsWith('s')) tokens.add(sub.slice(0, -1));
      }
    }
  }
  // Digits stuck to words/currency ("₹499per", "Rs.599/-") must still ground "499"/"599".
  for (const m of text.matchAll(/\d{3,}/g)) {
    tokens.add(m[0]);
  }
  const normalized = normalizePhrase(text);
  return {
    tokens,
    paddedText: ` ${normalized} `,
    collapsedText: normalized.replace(/\s+/g, ''),
  };
}

/**
 * True when a single word can be traced to the transcript.
 * Digits must appear in the source text — invented amounts/dates are hallucinations.
 * @param {string} token
 * @param {GroundingIndex} index
 */
export function isTokenGrounded(token, index) {
  const t = normalizeToken(token);
  if (!t) return true;
  if (/^\d+$/.test(t)) return index.tokens.has(t);
  if (NON_ENTITY_WORDS.has(t)) return true;
  if (index.tokens.has(t)) return true;
  if (t.length > 3 && t.endsWith('s') && index.tokens.has(t.slice(0, -1))) return true;
  const parts = compoundSubtokens(token);
  if (parts.length > 1 && parts.every((p) => p.length < 2 || NON_ENTITY_WORDS.has(p) || index.tokens.has(p))) {
    return true;
  }
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
  if (index.paddedText.includes(` ${p} `)) return true;
  const collapsed = p.replace(/\s+/g, '');
  return Boolean(collapsed && collapsed.length >= 4 && index.collapsedText?.includes(collapsed));
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

/**
 * @param {string} text
 * @param {GroundingIndex} entityIndex  chat (+ optional query names for negative answers)
 * @param {GroundingIndex} chatIndex    chat-only — amounts + relationships must live here
 * @param {{ skipSentenceStart?: boolean }} [opts]
 */
function ungroundedWords(text, entityIndex, chatIndex, opts) {
  const words = entityWords(text, opts);
  const bad = [];
  const relIndex = chatIndex || entityIndex;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const norm = normalizeToken(w);
    const indexForToken = /^\d+$/.test(norm) ? relIndex : entityIndex;
    if (isTokenGrounded(w, indexForToken)) continue;
    const prev = i > 0 ? words[i - 1] : '';
    const next = i + 1 < words.length ? words[i + 1] : '';
    const mergedPrev = prev ? normalizeToken(prev + w) : '';
    const mergedNext = next ? normalizeToken(w + next) : '';
    if ((mergedPrev && indexForToken.tokens.has(mergedPrev)) || (mergedNext && indexForToken.tokens.has(mergedNext))) {
      continue;
    }
    bad.push(w);
  }
  for (const rel of ungroundedRelationshipWords(text, relIndex)) {
    if (!bad.some((b) => normalizeToken(b) === normalizeToken(rel))) bad.push(rel);
  }
  for (const amt of ungroundedAmountTokens(text, relIndex)) {
    if (!bad.some((b) => normalizeToken(b) === normalizeToken(amt))) bad.push(amt);
  }
  return bad;
}

const RELATIONSHIP_WORDS = new Set([
  'wife', 'wives', 'husband', 'husbands', 'spouse', 'spouses', 'partner', 'partners',
  'fiance', 'fiancee', 'fiancée', 'brother', 'brothers', 'sister', 'sisters',
  'sibling', 'siblings', 'father', 'fathers', 'mother', 'mothers', 'dad', 'mom',
  'parent', 'parents', 'son', 'sons', 'daughter', 'daughters', 'child', 'children',
  'uncle', 'uncles', 'aunt', 'aunts', 'cousin', 'cousins', 'nephew', 'nephews',
  'niece', 'nieces', 'grandfather', 'grandmother', 'grandpa', 'grandma',
  'in-law', 'in-laws', 'brother-in-law', 'sister-in-law', 'father-in-law',
  'mother-in-law', 'son-in-law', 'daughter-in-law',
  'boss', 'bosses', 'manager', 'managers', 'colleague', 'colleagues',
  'coworker', 'coworkers', 'co-worker', 'co-workers', 'employee', 'employees',
  'employer', 'employers', 'girlfriend', 'boyfriend', 'roommate', 'roommates',
  'neighbor', 'neighbors', 'neighbour', 'neighbours',
]);

function isRelationshipWordGrounded(rawWord, index) {
  const norm = normalizeToken(rawWord);
  if (!norm) return true;
  if (index.tokens.has(norm)) return true;
  const singular = norm.endsWith('s') && norm.length > 3 ? norm.slice(0, -1) : '';
  return Boolean(singular && index.tokens.has(singular));
}

function ungroundedRelationshipWords(text, index) {
  const out = [];
  for (const m of String(text || '').matchAll(/\b[a-z][a-z\u2010\u2011'-]*\b/gi)) {
    const w = m[0];
    const lower = w.toLowerCase();
    if (!RELATIONSHIP_WORDS.has(lower)) continue;
    if (!isRelationshipWordGrounded(lower, index)) out.push(w);
  }
  return out;
}

/** Multi-digit amounts/dates (3+ digits) must appear in the chat — not only in the question. */
function ungroundedAmountTokens(text, chatIndex) {
  const out = [];
  for (const m of String(text || '').matchAll(/\b\d{3,}\b/g)) {
    const n = m[0];
    if (!chatIndex?.tokens?.has(normalizeToken(n))) out.push(n);
  }
  return out;
}

/**
 * Strip invented comma-delimited relationship appositives like
 * `Parul Garg, Rudraksh's wife, responded...` -> `Parul Garg responded...`.
 */
function stripUngroundedRelationshipAppositives(line, index, removed) {
  return String(line || '').replace(/,\s*([^,\n]{1,60}?)\s*,/g, (match, inner) => {
    const relBad = ungroundedRelationshipWords(inner, index);
    if (relBad.length === 0) return match;
    removed.push(inner.trim());
    return '';
  });
}

/**
 * Remove parenthetical glosses the model invented, e.g. `BSE (Bollywood Stock
 * Exchange)` → `BSE`. A parenthetical survives if it appears in the transcript
 * or contains no invented entity or relationship.
 */
function stripUngroundedParentheticals(line, entityIndex, chatIndex, removed) {
  return line.replace(/\s*\(([^()]*)\)/g, (match, inner) => {
    if (isPhraseGrounded(inner, entityIndex)) return match;
    const bad = ungroundedWords(inner, entityIndex, chatIndex, { skipSentenceStart: false });
    if (bad.length === 0) return match;
    removed.push(inner.trim());
    return '';
  });
}

function splitSentences(text) {
  const parts = String(text || '').match(/[^.!?]+[.!?]*\s*/g);
  return parts && parts.length ? parts : [String(text || '')];
}

function dropUngroundedSentences(line, entityIndex, chatIndex, removed) {
  const sentences = splitSentences(line);
  const kept = [];
  for (const s of sentences) {
    const bad = ungroundedWords(s, entityIndex, chatIndex, { skipSentenceStart: true });
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
 * `queryText` may supply entity *names* so negative answers can repeat the
 * asked-about term (e.g. "Bingetown was not found"). Relationships and amounts
 * still require the chat transcript — query wording alone is not evidence.
 *
 * @param {string} answer
 * @param {string} sourceText the transcript exactly as it was sent to the model
 * @param {string} [queryText]
 * @returns {{ text: string, removed: string[] }}
 */
export function enforceGroundedAnswer(answer, sourceText, queryText = '') {
  const chatIndex = buildGroundingIndex(sourceText);
  const entityIndex = queryText
    ? buildGroundingIndex(`${sourceText}\n${queryText}`)
    : chatIndex;
  const removed = [];
  const kept = [];

  for (const rawLine of String(answer || '').split('\n')) {
    const noRelAppositive = stripUngroundedRelationshipAppositives(rawLine, chatIndex, removed);
    const line = stripUngroundedParentheticals(noRelAppositive, entityIndex, chatIndex, removed);
    const listMatch = line.match(LIST_ITEM_RE);

    if (listMatch) {
      const [, marker, content] = listMatch;
      const bad = ungroundedWords(content, entityIndex, chatIndex, { skipSentenceStart: false });
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

    const prose = dropUngroundedSentences(line, entityIndex, chatIndex, removed);
    if (prose.trim()) kept.push(prose);
  }

  // Strip orphaned section headings or colon-terminated lead-in lines whose body/bullets were all removed
  const cleaned = [];
  for (let i = 0; i < kept.length; i++) {
    const cur = kept[i];
    const trimmed = cur.trim();
    const isHeadingOrLeadIn = /^#{1,6}\s+/.test(trimmed) || /:\s*$/.test(trimmed);
    if (isHeadingOrLeadIn) {
      let hasFollowingBody = false;
      for (let j = i + 1; j < kept.length; j++) {
        const nextTrimmed = kept[j].trim();
        if (!nextTrimmed) continue;
        if (/^#{1,6}\s+/.test(nextTrimmed)) break;
        hasFollowingBody = true;
        break;
      }
      if (!hasFollowingBody) continue;
    }
    cleaned.push(cur);
  }

  return { text: cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
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
 * Same as dropUnsupportedQuotes but for Ask AI `[m123]` handles.
 * `textsById` maps numeric message row id → message body text.
 *
 * @param {string} answer
 * @param {Map<number, string>|Record<number, string>} textsById
 * @returns {{ text: string, removed: string[] }}
 */
export function dropUnsupportedMessageQuotes(answer, textsById) {
  const removed = [];
  const kept = [];
  const lookup = textsById instanceof Map
    ? textsById
    : new Map(Object.entries(textsById || {}).map(([k, v]) => [Number(k), v]));

  for (const line of String(answer || '').split('\n')) {
    const citation = line.match(/\[m(\d+)\]/i);
    const quotes = [...line.matchAll(/["“]([^"”]{4,})["”]/g)].map((m) => m[1]);
    if (!citation || quotes.length === 0) {
      kept.push(line);
      continue;
    }
    const id = Number(citation[1]);
    const body = lookup.get(id);
    if (!body) {
      removed.push(citation[0]);
      continue;
    }
    const target = buildGroundingIndex(body);
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

/**
 * LLM-Driven Query Intent Decomposer & Multi-Query Expander.
 * Translates conversational user prompts into structured retrieval intents,
 * domain keywords, semantic expansions, and modality/direction filters.
 */

const FILLER_RE = /\b(?:can\s+you\s+)?(?:please\s+)?(?:search\s+(?:for\s+)?|find\s+(?:me\s+)?(?:the\s+)?|look\s+(?:for\s+)?|show\s+me\s+|where\s+(?:is|are|did\s+i|i\s+sent)\s+|tell\s+me\s+about\s+)\b/gi;
const IMAGE_RE = /\b(?:image|images|screenshot|screenshots|photo|photos|pic|pics|picture|pictures|receipt|receipts|bill|bills|qr|scan)\b/gi;
const DOC_RE = /\b(?:doc|docs|document|documents|pdf|pdfs|sheet|excel|csv|file|files|report|reports|presentation|deck|ppt|pptx)\b/gi;
const VIDEO_RE = /\b(?:video|videos|clip|clips|recording)\b/gi;
const AUDIO_RE = /\b(?:audio|voice|voice\s*note|recording|audio\s*file)\b/gi;
const OUTBOUND_RE = /\b(?:i\s+sent|sent\s+by\s+me|i\s+shared|i\s+uploaded|my\s+message|from\s+me)\b/i;
const INBOUND_RE = /\b(?:sent\s+to\s+me|received\s+from|shared\s+with\s+me|they\s+sent|she\s+sent|he\s+sent)\b/i;
const LATEST_RE = /\b(?:latest|recent|last|newest)\b/i;
const PDF_RE = /\b(?:pdf|pdfs)\b/i;
const DOCX_RE = /\b(?:doc|docx|word)\b/i;
const EXCEL_RE = /\b(?:sheet|excel|csv|xls|xlsx)\b/i;
const RETRY_RE = /^(?:try\s+again|retry|repeat|do\s+it\s+again|once\s+more|again|find\s+again)\b/i;

const FOLLOWUP_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'so', 'yet', 'nor',
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'u', 'you', 'your', 'yours',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'they', 'them', 'their',
  'this', 'that', 'these', 'those', 'there', 'here', 'where', 'when', 'who', 'whom',
  'what', 'which', 'how', 'why',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'done', 'doing',
  'have', 'has', 'had', 'having',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'in', 'into', 'inside', 'on', 'onto', 'at', 'to', 'for', 'from', 'with', 'by', 'of', 'about', 'over',
  'please', 'pls', 'plz', 'kindly', 'just', 'only', 'also', 'too', 'now', 'then', 'still', 'else',
  'any', 'some', 'same', 'more', 'other', 'another', 'both', 'each', 'all',
  'check', 'look', 'search', 'find', 'see', 'ask', 'tell', 'show', 'give', 'get', 'send', 'sent', 'try',
  'update', 'updates', 'news', 'info', 'details', 'answer', 'reply',
]);

const ELLIPTICAL_LEAD_RE = /^(?:what\s+about|how\s+about|what\s+of|and\s+(?:what\s+about|for|in|with)|same\s+(?:for|in|with)|check\s+(?:in|with|for)|look\s+(?:in|into))\b/i;
const BROAD_CHAT_QUESTION_RE = /\b(?:summarize|summary|overview|recap|this\s+(?:chat|group)|about\s+this)\b/i;

function extractMeaningfulTokens(text) {
  const cleaned = String(text || '')
    .replace(/@[\w.+-]+/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return cleaned
    .split(/\s+/)
    .filter((w) => w && w.length > 1 && !FOLLOWUP_STOP_WORDS.has(w));
}

function isUnderspecifiedFollowUp(raw) {
  const text = String(raw || '').trim();
  if (!text) return true;
  if (BROAD_CHAT_QUESTION_RE.test(text)) return false;
  const words = text.split(/\s+/).filter(Boolean);
  const meaningful = extractMeaningfulTokens(text);
  if (meaningful.length === 0) return true;
  if (ELLIPTICAL_LEAD_RE.test(text) && words.length <= 6 && meaningful.length <= 2) return true;
  return false;
}

function cleanFallbackText(query) {
  return String(query || '')
    .replace(FILLER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolves conversational follow-ups (e.g. "try again", "find again", pronouns "her", "him", "this chat").
 * Production RAG systems contextualize conversational references into a self-contained query before retrieval.
 */
export function contextualizeQuery(query, { prior = [], scopeChatName = null, scopeChatJid = null, directory = null } = {}) {
  const raw = String(query || '').trim();
  let effective = raw;
  let isRetry = false;
  let isFollowUp = false;

  if (RETRY_RE.test(raw) || (prior.length > 0 && isUnderspecifiedFollowUp(raw))) {
    isRetry = RETRY_RE.test(raw);
    isFollowUp = !isRetry;
    const lastUser = [...prior].reverse().find((m) => {
      if (m.role !== 'user') return false;
      const c = String(m.content || '').trim();
      return c && !RETRY_RE.test(c) && !isUnderspecifiedFollowUp(c);
    });
    if (lastUser && lastUser.content) {
      const priorTopic = String(lastUser.content).trim();
      const extraTokens = extractMeaningfulTokens(raw);
      effective = !isRetry && extraTokens.length > 0
        ? `${priorTopic} ${extraTokens.join(' ')}`
        : priorTopic;
    } else {
      isFollowUp = false;
    }
  }

  const intent = heuristicDecompose(effective);

  // If scoped to a known chat, resolve pronouns or context
  if (scopeChatName && !intent.candidateEntities.includes(scopeChatName)) {
    if (/\b(?:her|him|them|this\s+(?:group|chat)|here)\b/i.test(effective) || isRetry || isFollowUp) {
      intent.candidateEntities.unshift(scopeChatName);
    }
  }

  return {
    effectiveQuery: effective,
    isRetry,
    isFollowUp,
    intent,
  };
}

/**
 * Heuristic intent extractor when LLM provider is offline, slow, or returns malformed data.
 */
export function heuristicDecompose(query) {
  const q = String(query || '').trim();
  const cleaned = cleanFallbackText(q);

  let modality = null;
  if (IMAGE_RE.test(q)) modality = 'image';
  else if (DOC_RE.test(q)) modality = 'document';
  else if (VIDEO_RE.test(q)) modality = 'video';
  else if (AUDIO_RE.test(q)) modality = 'audio';

  const outboundOnly = OUTBOUND_RE.test(q);
  const inboundOnly = INBOUND_RE.test(q);
  const recency = LATEST_RE.test(q) ? 'latest' : null;
  const fileExt = PDF_RE.test(q) ? 'pdf' : (DOCX_RE.test(q) ? 'docx' : (EXCEL_RE.test(q) ? 'xlsx' : null));

  // Strip modality and recency words so "image", "photo", "pdf", "latest" are not searched as literal keywords
  let strippedText = cleaned;
  if (modality === 'image') strippedText = strippedText.replace(IMAGE_RE, ' ');
  else if (modality === 'document') strippedText = strippedText.replace(DOC_RE, ' ');
  else if (modality === 'video') strippedText = strippedText.replace(VIDEO_RE, ' ');
  else if (modality === 'audio') strippedText = strippedText.replace(AUDIO_RE, ' ');
  if (recency === 'latest') strippedText = strippedText.replace(LATEST_RE, ' ');
  strippedText = strippedText.replace(/\s+/g, ' ').trim();

  const lexicalQueries = new Set();
  const semanticQueries = new Set();

  if (strippedText) {
    lexicalQueries.add(strippedText);
    if (/\btc\b/i.test(strippedText)) {
      lexicalQueries.add(strippedText.replace(/\btc\b/gi, 'terms conditions').replace(/\s+/g, ' ').trim());
    }
  } else if (cleaned) {
    lexicalQueries.add(cleaned);
  }

  const candidateEntities = extractEntityCandidates(q);

  // Payment / billing / transaction synonym expansions
  if (/\b(?:pay|paid|payment|paying|bill|receipt|transfer|upi|sent\s+money|recharge|transaction|amount|spent|cost)\b/i.test(q)) {
    lexicalQueries.add('paid');
    lexicalQueries.add('payment');
    lexicalQueries.add('receipt');
    lexicalQueries.add('transaction');
    lexicalQueries.add('upi');
    semanticQueries.add('payment transaction receipt');
    semanticQueries.add('paid amount details');
    if (!modality && /\b(?:receipt|bill|screenshot|qr|upi|pay|paid|transaction)\b/i.test(q)) {
      // Often UPI or payment confirmations are shared as screenshots
      modality = 'image';
    }
  }

  // Common synonym expansions
  if (/\b(?:t\s*&\s*c|t\s+and\s+c|tnc|\btc\b|terms)\b/i.test(q)) {
    lexicalQueries.add('terms conditions');
    if (candidateEntities.length) {
      for (const ent of candidateEntities) {
        lexicalQueries.add(`${ent} terms conditions`);
        lexicalQueries.add(`${ent} cancellation`);
        lexicalQueries.add(`${ent} advance`);
      }
    } else {
      lexicalQueries.add('advance');
    }
    semanticQueries.add('cancellation policy');
    semanticQueries.add('refundable advance');
    semanticQueries.add('booking rules');
  }

  // Salon, Spa, Wellness & Beauty taxonomy expansions
  if (/\b(?:manicure|pedicure|nails?|nail\s*art|nail\s*extension|cuticle)\b/i.test(q)) {
    lexicalQueries.add('manicure');
    lexicalQueries.add('pedicure');
    lexicalQueries.add('nail care');
    lexicalQueries.add('nail services');
    lexicalQueries.add('hands & feet');
    lexicalQueries.add('hands feet');
    semanticQueries.add('nail care manicure pedicure services');
    semanticQueries.add('hands and feet salon rate card');
  }

  if (/\b(?:haircut|hair\s*wash|blow-?dry|hair\s*spa|keratin|beard|shaving|hair\s*colour)\b/i.test(q)) {
    lexicalQueries.add('hair styling');
    lexicalQueries.add('hair care');
    lexicalQueries.add('haircut');
    semanticQueries.add('hair styling and hair care salon services');
  }

  if (/\b(?:waxing|threading|bleach|facial|massage|head\s*massage|body\s*massage)\b/i.test(q)) {
    lexicalQueries.add('waxing');
    lexicalQueries.add('threading');
    lexicalQueries.add('hair removal');
    lexicalQueries.add('massage');
    semanticQueries.add('beauty and salon grooming services');
  }

  // Rate cards, pricing, tariff, and menus
  if (/\b(?:price|prices|rate|rates|cost|costing|charges?|tariff|menu|rate\s*card)\b/i.test(q)) {
    lexicalQueries.add('price');
    lexicalQueries.add('rate card');
    lexicalQueries.add('menu');
    lexicalQueries.add('tariff');
    semanticQueries.add('price list menu rate card');
    if (!modality && /\b(?:menu|rate\s*card|price\s*list|pdf|brochure)\b/i.test(q)) {
      modality = 'document';
    }
  }

  // Compound brand/venue handling
  if (/\bbingetown\b/i.test(q) || /\bbinge\s*town\b/i.test(q)) {
    lexicalQueries.add('thebingetown');
    lexicalQueries.add('binge town');
    lexicalQueries.add('bingetown');
  }

  return {
    cleanedQuery: strippedText || cleaned || q,
    lexicalQueries: Array.from(lexicalQueries),
    semanticQueries: Array.from(semanticQueries),
    modality,
    outboundOnly,
    inboundOnly,
    recency,
    fileExt,
    candidateEntities,
    expandScopeIfEmpty: true,
  };
}

function extractEntityCandidates(query) {
  const candidates = [];
  const m = String(query).match(/\b(?:bingetown|binge\s+town|amazon|flipkart|zomato|swiggy|sharma|bhaiyao|uber|ola)\b/gi);
  if (m) {
    for (const item of m) {
      const clean = item.trim();
      if (!candidates.includes(clean)) candidates.push(clean);
    }
  }
  return candidates;
}

/**
 * Decomposes natural language search query using the active LLM provider.
 * Falls back to deterministic heuristic if provider is unavailable or exceeds timeout.
 */
export async function decomposeQuery(query, { provider = null, currentChatName = null, timeoutMs = 2500 } = {}) {
  const rawQuery = String(query || '').trim();
  if (!rawQuery) {
    return {
      cleanedQuery: '',
      lexicalQueries: [],
      semanticQueries: [],
      modality: null,
      outboundOnly: false,
      candidateEntities: [],
      expandScopeIfEmpty: true,
    };
  }

  if (!provider || typeof provider.chat !== 'function') {
    return heuristicDecompose(rawQuery);
  }

  const prompt = `You are a search query understanding engine for a WhatsApp archive assistant.
Analyze the user's natural language request and extract the search intent, keywords, synonyms, parent/umbrella categories, and filters.

Guidelines:
- Parent & Domain Categories: If the query mentions specific items or services (e.g. "manicure", "pedicure", "haircut", "gym", "catering"), include their parent categories, section headers, and domain synonyms in lexicalQueries and semanticQueries (e.g. for "manicure" or "pedicure", include "nail care", "nail services", "hands and feet", "salon menu"; for "haircut", include "hair styling", "salon").
- Pricing & Rate Lists: If asking about prices, rates, cost, or available services, include document and menu terms like "rate card", "price list", "menu", "charges".
- Modality: Set to "document" if looking for menus, rate cards, price lists, brochures, or policies; "image" for receipts or photos; or null for general messages.

Current active chat context: "${currentChatName || 'None'}"
User Query: "${rawQuery}"

Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{
  "cleanedQuery": "<core search phrase without conversational filler like 'search for' or 'where I sent'>",
  "lexicalQueries": ["<exact words, section headers, brand names, URLs, or variations, e.g. 'nail care', 'manicure', 'rate card'>"],
  "semanticQueries": ["<conceptual synonyms, e.g. for 'manicure' use 'nail care hands and feet salon services', 'cancellation policy'>"],
  "modality": "<'image' | 'document' | 'video' | 'audio' | null>",
  "outboundOnly": <true if user says 'where I sent' or 'my message', false otherwise>,
  "candidateEntities": ["<names of people, businesses, services, or groups mentioned>"],
  "expandScopeIfEmpty": <true if search should search outside current chat if 0 results found>
}`;

  const callPromise = provider.chat(
    [
      { role: 'system', content: 'You are a search intent decomposer. Output strict JSON only.' },
      { role: 'user', content: prompt },
    ],
    { maxTokens: 250, temperature: 0.1 },
  );

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Query decomposition timeout')), timeoutMs);
  });

  try {
    const raw = await Promise.race([callPromise, timeoutPromise]);
    const text = String(raw || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return heuristicDecompose(rawQuery);

    const parsed = JSON.parse(jsonMatch[0]);
    const fallback = heuristicDecompose(rawQuery);

    const lexical = Array.isArray(parsed.lexicalQueries) && parsed.lexicalQueries.length
      ? parsed.lexicalQueries.map(String).filter(Boolean)
      : fallback.lexicalQueries;

    const semantic = Array.isArray(parsed.semanticQueries) && parsed.semanticQueries.length
      ? parsed.semanticQueries.map(String).filter(Boolean)
      : fallback.semanticQueries;

    const entities = Array.isArray(parsed.candidateEntities) && parsed.candidateEntities.length
      ? parsed.candidateEntities.map(String).filter(Boolean)
      : fallback.candidateEntities;

    return {
      cleanedQuery: String(parsed.cleanedQuery || fallback.cleanedQuery || rawQuery).trim(),
      lexicalQueries: Array.from(new Set([...lexical, ...fallback.lexicalQueries])),
      semanticQueries: Array.from(new Set([...semantic, ...fallback.semanticQueries])),
      modality: parsed.modality || fallback.modality,
      outboundOnly: typeof parsed.outboundOnly === 'boolean' ? parsed.outboundOnly : fallback.outboundOnly,
      candidateEntities: Array.from(new Set([...entities, ...fallback.candidateEntities])),
      expandScopeIfEmpty: parsed.expandScopeIfEmpty !== false,
    };
  } catch (err) {
    return heuristicDecompose(rawQuery);
  }
}

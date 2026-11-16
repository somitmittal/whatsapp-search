/**
 * LLM-Driven Query Intent Decomposer & Multi-Query Expander.
 * Translates conversational user prompts into structured retrieval intents,
 * domain keywords, semantic expansions, and modality/direction filters.
 */

const FILLER_RE = /\b(?:can\s+you\s+)?(?:please\s+)?(?:search\s+(?:for\s+)?|find\s+(?:me\s+)?(?:the\s+)?|look\s+(?:for\s+)?|show\s+me\s+|where\s+(?:is|are|did\s+i|i\s+sent)\s+|tell\s+me\s+about\s+)\b/gi;
const IMAGE_RE = /\b(?:image|images|screenshot|screenshots|photo|photos|pic|pics|picture|pictures|receipt|receipts|bill|bills|qr|scan)\b/i;
const DOC_RE = /\b(?:doc|docs|document|documents|pdf|pdfs|sheet|excel|csv|file|files)\b/i;
const VIDEO_RE = /\b(?:video|videos|clip|clips|recording)\b/i;
const AUDIO_RE = /\b(?:audio|voice|voice\s*note|recording|audio\s*file)\b/i;
const OUTBOUND_RE = /\b(?:i\s+sent|sent\s+by\s+me|i\s+shared|i\s+uploaded|my\s+message|from\s+me)\b/i;

function cleanFallbackText(query) {
  return String(query || '')
    .replace(FILLER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

  // Extract candidate tokens
  const words = cleaned
    .replace(/[^\w\s&]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const lexicalQueries = new Set();
  const semanticQueries = new Set();

  if (cleaned) lexicalQueries.add(cleaned);

  // Common synonym expansions
  if (/\b(?:t\s*&\s*c|t\s+and\s+c|tnc|terms)\b/i.test(q)) {
    lexicalQueries.add('terms conditions');
    semanticQueries.add('cancellation policy');
    semanticQueries.add('refundable advance');
    semanticQueries.add('booking rules');
  }

  // Compound brand/venue handling
  if (/\bbingetown\b/i.test(q) || /\bbinge\s*town\b/i.test(q)) {
    lexicalQueries.add('thebingetown');
    lexicalQueries.add('binge town');
    lexicalQueries.add('bingetown');
  }

  return {
    cleanedQuery: cleaned || q,
    lexicalQueries: Array.from(lexicalQueries),
    semanticQueries: Array.from(semanticQueries),
    modality,
    outboundOnly,
    candidateEntities: extractEntityCandidates(q),
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
Analyze the user's natural language request and extract the search intent, keywords, synonyms, and filters.

Current active chat context: "${currentChatName || 'None'}"
User Query: "${rawQuery}"

Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{
  "cleanedQuery": "<core search phrase without conversational filler like 'search for' or 'where I sent'>",
  "lexicalQueries": ["<exact words, brand names, URLs, or variations, e.g. 'thebingetown', 'binge town'>"],
  "semanticQueries": ["<conceptual synonyms, e.g. for 't&c' use 'cancellation policy', 'refundable advance', 'terms'>"],
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

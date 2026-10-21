import {
  amountCandidatesMinor,
  amountGroundedInText,
  isoDate,
  normalizeCurrency,
  normalizeDigits,
  normalizeDirection,
  parseAmountMinor,
  stripNonAmountNumbers,
} from './expense-utils.js';

const BATCH_MAX_LINES = 20;
export const BATCH_MAX_CHARS = 9000;

function balancedJsonValues(text) {
  const candidates = [];
  for (let start = 0; start < text.length; start += 1) {
    const first = text[start];
    if (first !== '[' && first !== '{') continue;
    const stack = [first];
    let inString = false;
    let escaped = false;
    for (let i = start + 1; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '[' || char === '{') stack.push(char);
      else if (char === ']' || char === '}') {
        const open = stack.pop();
        if ((open === '[' && char !== ']') || (open === '{' && char !== '}')) break;
        if (!stack.length) {
          candidates.push(text.slice(start, i + 1));
          start = i;
          break;
        }
      }
    }
  }
  return candidates;
}

export function parseJson(raw, fallback) {
  const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  for (const candidate of balancedJsonValues(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') {
        for (const key of ['expenses', 'entries', 'transactions', 'items', 'data']) {
          if (Array.isArray(parsed[key])) return parsed[key];
        }
        return parsed;
      }
    } catch { /* try the next balanced JSON value */ }
  }
  return fallback;
}

/**
 * Rows from a model reply: a JSON array of objects, an object wrapping one, or — from small
 * models — one or more bare positional arrays (["2026-01-03", "Room rent", ..., "9500"]).
 * Returns null when the reply has no usable JSON.
 */
export function parseJsonRows(raw) {
  const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const values = [];
  for (const candidate of balancedJsonValues(text)) {
    try { values.push(JSON.parse(candidate)); } catch { /* skip invalid fragments */ }
  }
  const isTuple = (value) => Array.isArray(value) && value.length > 1
    && value.every((cell) => cell == null || typeof cell !== 'object');
  for (const value of values) {
    if (Array.isArray(value) && !isTuple(value)) return value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of ['expenses', 'entries', 'transactions', 'items', 'rows', 'data']) {
        if (Array.isArray(value[key])) return value[key];
      }
      return Object.keys(value).length ? [value] : [];
    }
  }
  const tuples = values.filter(isTuple);
  if (tuples.length) return tuples;
  return values.some((value) => Array.isArray(value)) ? [] : null;
}

/** Map a positional model row onto named fields (same order the prompt lists them). */
export function rowObject(item, fields) {
  if (!Array.isArray(item)) return item;
  return Object.fromEntries(fields.map((field, index) => [field, item[index]]));
}

const CHAT_FIELDS = ['source_message_id', 'amount', 'currency', 'direction', 'date', 'payee', 'category', 'description', 'reference'];

/** JSON schema for {"expenses": [...]}, used by providers that support constrained output. */
export function expensesSchema(fields, required) {
  const properties = Object.fromEntries(fields.map((field) => [
    field,
    field === 'amount' ? { type: 'number' }
      : field === 'direction' ? { type: 'string', enum: ['debit', 'credit'] }
        : { type: 'string' },
  ]));
  return {
    type: 'object',
    properties: { expenses: { type: 'array', items: { type: 'object', properties, required } } },
    required: ['expenses'],
  };
}

const CHAT_SCHEMA = expensesSchema(CHAT_FIELDS, ['source_message_id', 'amount', 'direction', 'description']);

export function dayBoundsFromTimestamp(timestamp) {
  let seconds = Number(timestamp);
  if (seconds > 100_000_000_000) seconds /= 1000;
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(date.getTime())) {
    throw new Error('Invalid message timestamp');
  }
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return {
    date: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
    startTs: Math.floor(start.getTime() / 1000),
    endTs: Math.floor(end.getTime() / 1000) - 1,
  };
}

export function dayBoundsFromDate(date) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Invalid business date');
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1);
  return {
    date: String(date),
    startTs: Math.floor(start.getTime() / 1000),
    endTs: Math.floor(end.getTime() / 1000) - 1,
  };
}

export async function inferExpenseHeaders(provider, headers, canonicalFields) {
  if (!provider?.chat) return {};
  const prompt = `Map spreadsheet header labels to canonical expense fields.
Return ONLY one JSON object whose keys are exact input headers and values are one of:
${canonicalFields.join(', ')}
Omit headers that do not map. Do not invent headers.

Input headers:
${JSON.stringify(headers)}`;
  const raw = await provider.chat([{ role: 'user', content: prompt }], {
    temperature: 0,
    maxTokens: 400,
  });
  const parsed = parseJson(raw, {});
  return parsed && !Array.isArray(parsed) ? parsed : {};
}

function normalizeExtractedExpense(rawItem) {
  const item = rowObject(rawItem, CHAT_FIELDS);
  if (!item || typeof item !== 'object') return null;
  const amountMinor = item?.amountMinor != null
    ? Math.round(Number(item.amountMinor))
    : parseAmountMinor(item?.amount ?? item?.amount_value ?? item?.value);
  if (!Number.isFinite(amountMinor) || amountMinor === 0) return null;
  return {
    source: 'chat',
    sourceMessageId: extractedSourceId(item),
    date: isoDate(item.date, null),
    amountMinor: Math.abs(amountMinor),
    currency: normalizeCurrency(item.currency),
    direction: normalizeDirection(item.direction, amountMinor),
    description: String(item.description || item.context || '').trim(),
    payee: String(item.payee || item.vendor || '').trim(),
    category: String(item.category || '').trim(),
    reference: String(item.reference || '').trim(),
    rawJson: JSON.stringify(item),
  };
}

const ENGLISH_TRANSACTION = /\b(?:paid|pay|payment|paymnt|spent|spend|purchase|purchased|bought|expense|expenses|cost|debit|charged|refund(?:ed)?|reimbursed|reimbursement)\b/i;
const HINGLISH_TRANSACTION = /\b(?:diye|diya|dijiye|de\s?do|dedo|daal\s?do|dal\s?do|dalwa\w*|bhej\w*|transfer\w*|kharch\w*|bhugtan)\b/i;
const DEVANAGARI_TRANSACTION = /(?:दिए|दिया|दे\s?दो|डाल|डलवा|भेज|भुगतान|खर्च|पेमेंट)/;
const OUTGOING_REQUEST = /\b(?:paid|pay|payment|paymnt|spent|spend|purchase|purchased|bought|charged|charge|debit|daal\s?do|dal\s?do|dalwa\w*|bhej\s?do|pay\s?kar\w*)\b|डाल\s?दो|डलवा|भेज\s?दो/i;
const BARE_AMOUNT = /^(?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d{1,2})?\s*(?:\/-|\/|rs\.?|rupees?|k|₹)?$/i;
const PAYMENT_CONFIRMATION = /paid using phonepe|paid via|payment (?:successful|done)|transaction successful|paid successfully|google pay|\bgpay\b|paytm|\bupi\b/i;

/** Chat text the model sees: attachment noise removed, media marked, indexed image/OCR text appended. */
function messageBody(row) {
  let body = String(row.text || row.mediaCaption || '')
    .replace(/[\u200e\u200f]/g, '')
    .replace(/<attached:\s*[^>]*\.(?:jpe?g|png|webp|gif|heic)\s*>/gi, '[image]')
    .replace(/<attached:\s*[^>]*>/gi, '[file]')
    .replace(/\b(image|video|audio|sticker|GIF|document) omitted\b/gi, (_, kind) => `[${kind.toLowerCase()}]`)
    .replace(/Explore the app now:?/gi, '')
    .replace(/•\s*\d+\s*pages?\b/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (row.mediaType === 'image' && !body.includes('[image]')) body = `${body} [image]`.trim();
  const mediaText = String(row.mediaAiIndex || '').replace(/\s+/g, ' ').trim();
  if (mediaText) body = `${body} [${row.mediaType || 'media'} text: ${mediaText}]`;
  return normalizeDigits(body);
}

/** 'explicit' = amount + payment wording; 'bare' = a message that is only an amount; else 'none'. */
function evidenceKind(body, mediaType) {
  if (mediaType === 'document') return 'none';
  if (!amountCandidatesMinor(body).size) return 'none';
  const clean = stripNonAmountNumbers(body).replace(/\[(?:image|file|video|audio|sticker|gif|document)\]/gi, '').trim();
  if (BARE_AMOUNT.test(clean)) return 'bare';
  const advance = /\badvance\b/i.test(body) && /\b(?:received|collected|from\s+(?:the\s+)?client|client|paid|payment)\b/i.test(body);
  if (ENGLISH_TRANSACTION.test(body) || HINGLISH_TRANSACTION.test(body) || DEVANAGARI_TRANSACTION.test(body) || advance) {
    return 'explicit';
  }
  return 'none';
}

function prepareRows(eligible, date) {
  return eligible.map((row, index) => {
    const body = messageBody(row);
    const rowDate = messageDate(row, date);
    return {
      row,
      index,
      id: String(row.messageId),
      date: rowDate,
      body,
      hasAmount: row.mediaType !== 'document' && amountCandidatesMinor(body).size > 0,
      evidence: evidenceKind(body, row.mediaType),
      line: `[${row.messageId}] [${rowDate || ''}${messageTime(row)}] ${row.sender || 'Unknown'}: ${body}`,
    };
  });
}

/** Rows with amounts plus their immediate neighbours (payee numbers, "image", purpose) as context. */
function transcriptRows(prepared) {
  const keep = new Set();
  prepared.forEach((item, index) => {
    if (!item.hasAmount && !item.row.mediaAiIndex) return;
    keep.add(index - 1);
    keep.add(index);
    keep.add(index + 1);
  });
  return prepared.filter((_, index) => keep.has(index));
}

function batchesOf(rows) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const item of rows) {
    const size = item.line.length + 1;
    if (batch.length && (batch.length >= BATCH_MAX_LINES || chars + size > BATCH_MAX_CHARS)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(item);
    chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * Keep a model row only if its amount is literally written in the cited message.
 * Small models often cite the neighbouring "image" or phone-number message instead, so
 * re-attribute to the nearest message (within two lines) that does contain the amount.
 */
function groundedSource(entry, prepared, byId) {
  const claimed = byId.get(entry.sourceMessageId);
  if (claimed?.hasAmount && amountGroundedInText(entry.amountMinor, claimed.body)) return claimed;
  if (claimed) {
    for (const distance of [1, 2]) {
      for (const index of [claimed.index + distance, claimed.index - distance]) {
        const neighbour = prepared[index];
        if (neighbour && neighbour.hasAmount && amountGroundedInText(entry.amountMinor, neighbour.body)) return neighbour;
      }
    }
  }
  const anywhere = prepared.filter((item) => item.hasAmount && amountGroundedInText(entry.amountMinor, item.body));
  return anywhere.length === 1 ? anywhere[0] : null;
}

const CREDIT_CUE = /\b(?:received|recd|refund(?:ed)?|reimburs\w*|mil\s?gaye|mil\s?gya|jama|credited)\b|मिल\s?गए|जमा|प्राप्त/i;
const FUNDS_GIVEN = /\b(?:diye|diya|bhej\s?diye|bhej\s?diya|transfer\s?kar\s?diya|transfer\s?kiye)\b|दिए|दिया/i;
const TO_SOMEONE = /\bko\b|को/i;

/**
 * Paid vs received from explicit wording in the message; the model's reading is kept only
 * when the message has no cue. Small models flip bare amounts ("4800/-") to credit.
 */
function chatDirection(body, modelDirection, evidence) {
  const text = String(body || '');
  const clientAdvance = /\badvance\b/i.test(text) && /\b(?:received|collected|from\s+(?:the\s+)?client|client)\b/i.test(text);
  // The payer's own PhonePe/UPI confirmation is outgoing even if the receipt text says "received".
  if (PAYMENT_CONFIRMATION.test(text)) return 'debit';
  if (CREDIT_CUE.test(text) || clientAdvance) return 'credit';
  if (OUTGOING_REQUEST.test(text)) return 'debit';
  if (FUNDS_GIVEN.test(text)) return TO_SOMEONE.test(text) ? 'debit' : 'credit';
  if (evidence === 'bare') return 'debit';
  return modelDirection;
}

/** Drop model placeholders ("None", "null", or just the amount repeated). */
function meaningfulText(value, amountMinor) {
  const text = String(value ?? '').trim();
  if (!text || /^(?:none|null|nil|n\/?a|undefined|-+)$/i.test(text)) return '';
  if (parseAmountMinor(text) === amountMinor && !/[a-z\u0900-\u097f]{2}/i.test(text)) return '';
  return text;
}

function groundEntries(items, prepared, byId) {
  const entries = [];
  const seen = new Set();
  for (const item of items) {
    const extracted = normalizeExtractedExpense(item);
    if (!extracted) continue;
    const source = groundedSource(extracted, prepared, byId);
    if (!source) continue;
    const entry = {
      ...extracted,
      direction: chatDirection(source.body, extracted.direction, source.evidence),
      description: meaningfulText(extracted.description, extracted.amountMinor),
      payee: meaningfulText(extracted.payee, extracted.amountMinor),
      category: meaningfulText(extracted.category, extracted.amountMinor),
      reference: meaningfulText(extracted.reference, extracted.amountMinor),
    };
    const key = `${source.id}|${entry.amountMinor}|${entry.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Models often copy the sender into payee; the sender is who asked, not who was paid.
    const sender = String(source.row.sender || '').trim().toLowerCase();
    const payee = entry.payee && entry.payee.trim().toLowerCase() === sender ? '' : entry.payee;
    entries.push(attachSourceEvidence(
      backfillReferenceFromMessage({ ...entry, payee, sourceMessageId: source.id, date: source.date }, source.row),
      source,
    ));
  }
  return entries;
}

/** A PhonePe/UPI confirmation of a payment already requested in chat is the same transaction. */
function dropConfirmationDuplicates(entries) {
  return entries.filter((entry) => {
    if (!PAYMENT_CONFIRMATION.test(entry.sourceText || '')) return true;
    return !entries.some((other) => (
      other !== entry
      && !PAYMENT_CONFIRMATION.test(other.sourceText || '')
      && other.amountMinor === entry.amountMinor
      && other.direction === entry.direction
      && other.date === entry.date
    ));
  });
}

/**
 * @param {object} provider
 * @param {object[]} messages
 * @param {{ date?: string, excludedMessageId?: string|null, onUnreadable?: (rows: object[]) => void }} [options]
 *   onUnreadable receives payment-like messages whose amount could not be read safely; without it, they throw.
 */
export async function extractChatExpenses(provider, messages, {
  date,
  excludedMessageId = null,
  onUnreadable = null,
} = {}) {
  if (!provider?.chat) throw new Error('An AI provider is required to extract chat expenses');
  const eligible = (messages || []).filter((row) => row.messageId !== excludedMessageId);
  if (!eligible.length) return [];
  const prepared = prepareRows(eligible, date);
  const transcript = transcriptRows(prepared);
  if (!transcript.length) return [];
  const byId = new Map(prepared.map((item) => [item.id, item]));

  const failures = [];
  const outputs = await Promise.all(batchesOf(transcript).map((group) => (
    extractBatch(provider, group, date, 0, false, failures)
  )));
  if (failures.length === transcript.length) throw invalidJsonError(provider);
  const entries = groundEntries(outputs.flat(), prepared, byId);

  const covered = () => new Set(entries.map((entry) => entry.sourceMessageId));
  let coveredIds = covered();
  const uncovered = prepared.filter((item) => item.evidence !== 'none' && !coveredIds.has(item.id));
  // Models sometimes return valid JSON while silently omitting a transaction. Retry just
  // those messages (with the line before each for context), then fall back deterministically.
  if (uncovered.length) {
    const retryIndexes = new Set(uncovered.flatMap((item) => [item.index - 1, item.index]));
    const retryRows = prepared.filter((item) => retryIndexes.has(item.index));
    const retryOutput = await extractBatch(provider, retryRows, date, 0, true, []);
    for (const entry of groundEntries(retryOutput, prepared, byId)) {
      if (!entries.some((e) => e.sourceMessageId === entry.sourceMessageId && e.amountMinor === entry.amountMinor)) {
        entries.push(entry);
      }
    }
    coveredIds = covered();
    const stillUncovered = uncovered.filter((item) => !coveredIds.has(item.id));
    const fallbackEntries = stillUncovered
      .map((item) => deterministicExpenseFallback(item, prepared))
      .filter(Boolean);
    entries.push(...fallbackEntries);
    const unresolved = stillUncovered.filter((item) => (
      item.evidence === 'explicit'
      && !fallbackEntries.some((entry) => entry.sourceMessageId === item.id)
    ));
    if (unresolved.length) {
      if (typeof onUnreadable === 'function') {
        onUnreadable(unresolved.map((item) => ({
          messageId: item.id,
          date: item.date,
          sender: item.row.sender || '',
          text: item.body,
        })));
      } else {
        throw new Error(
          `Expense extraction could not safely read ${unresolved.length} transaction-like chat message(s). `
          + 'Check that each message states a clear amount and payment direction, then retry.',
        );
      }
    }
  }
  const order = new Map(prepared.map((item) => [item.id, item.index]));
  return dropConfirmationDuplicates(entries)
    .map((entry) => ({ ...entry, sourceContext: senderContext(byId.get(entry.sourceMessageId), prepared) }))
    .sort((a, b) => (order.get(a.sourceMessageId) ?? 0) - (order.get(b.sourceMessageId) ?? 0));
}

/**
 * The same sender's adjacent messages ("Pqrs सुखराम डीजल" then "10000", or "2500/-" then
 * "Diesel jcb mahroi") — literal chat words the reconciler may use to confirm a match.
 */
function senderContext(item, prepared) {
  if (!item) return '';
  return [prepared[item.index - 1], prepared[item.index + 1]]
    .filter((neighbour) => neighbour && neighbour.row.sender === item.row.sender && neighbour.row.mediaType !== 'document')
    .map((neighbour) => neighbour.body)
    .join(' ');
}

/**
 * A message that is only an amount is a payment request when it is marked as money
 * ("4800/-", "₹10000") or follows the same sender's payee number / photo / name.
 */
function bareAmountFallback(item, prepared) {
  const text = item.body;
  const marked = /\/-|₹|\brs\.?\b|\binr\b/i.test(text);
  const previous = prepared[item.index - 1];
  const continues = previous && previous.row.sender === item.row.sender;
  if (!marked && !continues) return null;
  const [amountMinor, ...rest] = [...amountCandidatesMinor(text)];
  if (!amountMinor || rest.length) return null;
  return attachSourceEvidence({
    source: 'chat',
    sourceMessageId: item.id,
    date: item.date,
    amountMinor,
    currency: 'INR',
    direction: 'debit',
    description: '',
    payee: '',
    category: '',
    reference: '',
    rawJson: JSON.stringify({ deterministicFallback: 'bare-amount' }),
  }, item);
}

/** Deterministically recover a simple, explicit payment when the model omits it. */
function deterministicExpenseFallback(item, prepared = []) {
  const text = item?.body || '';
  if (!text || !item?.id) return null;
  if (item.evidence === 'bare') return bareAmountFallback(item, prepared);
  const outgoing = OUTGOING_REQUEST.test(text);
  const refund = /\b(?:refund(?:ed)?|reimbursed|reimbursement)\b/i.test(text);
  const incomingAdvance = /\badvance\b/i.test(text)
    && /\b(?:received|collected|from\s+(?:the\s+)?client|client)\b/i.test(text);
  if (!outgoing && !refund && !incomingAdvance) return null;

  const currencyAmounts = [...text.matchAll(/(?:₹|\b(?:rs\.?|inr|usd|eur|gbp|cad|aud)\s*|[$€£])\s*\(?\s*-?\d[\d,]*(?:[.,]\d{1,2})?\)?(?:\s*(?:k|thousand|l|lac|lakh|m|million|cr|crore))?/gi)];
  let amountToken = currencyAmounts.length === 1 ? currencyAmounts[0][0] : null;
  if (!amountToken && currencyAmounts.length === 0) {
    const amountAfterVerb = text.match(/\b(?:paid|pay|payment|spent|spend|purchase|purchased|bought|charged|charge|debit|refund(?:ed)?|reimbursed|reimbursement|received|collected|advance)\b[^.!?]{0,60}?\b(\d[\d,]*(?:\.\d{1,2})?\s*(?:k|thousand|l|lac|lakh|m|million|cr|crore)?)(?![/.]\d)\b/i);
    if (amountAfterVerb) amountToken = amountAfterVerb[1].trim();
  }
  let amountMinor = amountToken ? parseAmountMinor(amountToken) : null;
  if (amountMinor == null && currencyAmounts.length === 0) {
    const candidates = [...amountCandidatesMinor(text)];
    if (candidates.length === 1) [amountMinor] = candidates;
  }
  if (amountMinor == null || amountMinor === 0 || !amountGroundedInText(amountMinor, text)) return null;

  const reference = text.match(/\b(?:ref(?:erence)?|voucher|invoice|bill)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{2,})\b/i)?.[1] || '';
  return attachSourceEvidence({
    source: 'chat',
    sourceMessageId: item.id,
    date: item.date,
    amountMinor: Math.abs(amountMinor),
    currency: normalizeCurrency(amountToken || 'INR'),
    direction: refund || incomingAdvance ? 'credit' : 'debit',
    description: text,
    payee: '',
    category: incomingAdvance ? 'client advance' : 'other',
    reference,
    rawJson: JSON.stringify({ deterministicFallback: true }),
  }, item);
}

function expensePrompt(group, date, correction = false) {
  const transcript = group.map((item) => item.line).join('\n');
  return `You read a business or work-site WhatsApp group and list every money movement, so it can be checked against the accountant's expense sheet. Messages can be English, Hindi, or Hinglish (Hindi typed in English letters), informal, and one payment is often split over several consecutive messages (an image, a phone number, then an amount, then a confirmation).

Return ONLY one JSON object, no markdown or prose: {"expenses": [ ... ]} with one item per transaction (an empty list if none). Each item: source_message_id, amount, currency, direction, date, payee, category, description, reference.

Rules:
- source_message_id: the ID in square brackets of the message where the amount is written. Never invent, shorten, or combine IDs.
- amount: a number literally written in that message (or in its [image text: ...]). Expand only shorthand like 1.5k, 2 lakh, 1 cr. Never add up, split, or guess amounts. A screenshot or "[image]" with no readable amount has no amount.
- These are NOT amounts: phone numbers (10-digit mobiles such as 9876543210, +91 ...), UPI IDs, account/IFSC numbers, UTR or transaction IDs, bill/CA/consumer numbers, dates, times, page counts, quantities ("4 tractor", "3 bags", "4*500" is a rate — use only an amount that is written as the payment).
- A message that is only an amount ("1500", "4800/-", "₹10000") right after an image, phone number, or request is a request to pay that amount; take payee/purpose from the nearby messages.
- A request ("pay kar do", "dal do", "dalwa dijiye", "bhej do", "please pay") and its later confirmation ("Paid using PhonePe UPI", a payment screenshot, "done", "paid") are ONE transaction: report it once, on the message with the amount.
- direction "debit": money paid out — expenses, diesel, labour, advances paid to workers/vendors, bills, purchases.
- direction "credit": money received by the person who pays — funds or top-ups sent to them ("40000 diye", "transfer kar diya", "bhej diye", "mil gaye", "received"), refunds, client advances.
- "X ko diye / X ko de do" means paid to X (debit). "diye" from a funder with no recipient named means funds received (credit).
- description: short, in the chat's own words (e.g. "Hydra diesel", "labour advance"); payee if a person or vendor is named; category "other" if none stated.
- date: the date on that message's label${date ? ` (default ${date})` : ''}.
- Omit greetings, discussion, uploaded sheets/PDFs, balances and totals ("total dena hai", "baki", "balance"), and messages without an amount.
- If nothing qualifies, return {"expenses": []}.
${correction ? '- Earlier output was invalid or missed payments. Check every line that contains an amount. Ensure every quote, comma, and bracket makes the JSON valid.\n' : ''}
Transcript:
${transcript}`;
}

/**
 * One model call per batch (plus a corrective retry). Invalid JSON splits the batch; a single
 * line that still fails is recorded in `failures` instead of failing the whole run, so its
 * payment (if any) surfaces through the retry / fallback / unreadable path.
 */
async function extractBatch(provider, group, date, depth = 0, correction = false, failures = null) {
  const first = await provider.chat([{ role: 'user', content: expensePrompt(group, date, correction) }], {
    temperature: 0,
    maxTokens: 2048,
    numCtx: 8192,
    jsonSchema: CHAT_SCHEMA,
  });
  let parsed = parseJsonRows(first);
  if (!Array.isArray(parsed) || (parsed.length === 0 && group.some((item) => item.evidence !== 'none'))) {
    const retry = await provider.chat([{ role: 'user', content: expensePrompt(group, date, true) }], {
      temperature: 0,
      maxTokens: 4096,
      numCtx: 8192,
      jsonSchema: CHAT_SCHEMA,
    });
    parsed = parseJsonRows(retry) ?? (Array.isArray(parsed) ? parsed : null);
  }
  if (Array.isArray(parsed)) return parsed;
  if (group.length > 1 && depth < 8) {
    const middle = Math.ceil(group.length / 2);
    const left = await extractBatch(provider, group.slice(0, middle), date, depth + 1, false, failures);
    const right = await extractBatch(provider, group.slice(middle), date, depth + 1, false, failures);
    return [...left, ...right];
  }
  if (failures) {
    failures.push(...group);
    return [];
  }
  throw invalidJsonError(provider);
}

function invalidJsonError(provider) {
  const model = [provider?.name, provider?.model].filter(Boolean).join('/');
  return new Error(`Expense extraction returned invalid JSON after retry${model ? ` (${model})` : ''}.`);
}

/** Prefer an explicit Ref … token in the message over a flaky model reference. */
function backfillReferenceFromMessage(entry, messageRow) {
  if (!entry) return entry;
  const text = String(messageRow?.text || messageRow?.mediaCaption || '');
  const match = text.match(/\bRef(?:erence)?\s*[:#-]?\s*(VOU-[A-Z0-9-]+)/i);
  if (!match) return entry;
  const fromText = match[1].trim();
  const current = String(entry.reference || '').trim();
  if (current && current.toUpperCase() === fromText.toUpperCase()) return entry;
  return { ...entry, reference: fromText };
}

function messageDate(row, fallbackDate) {
  const timestamp = Number(row?.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) return dayBoundsFromTimestamp(timestamp).date;
  return fallbackDate;
}

function extractedSourceId(item) {
  return String(item?.source_message_id || item?.sourceMessageId || item?.message_id || item?.messageId || item?.id || '')
    .trim()
    .replace(/^\[(.+)\]$/, '$1')
    .trim();
}

function messageTime(row) {
  const timestamp = Number(row?.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const date = new Date((timestamp > 100_000_000_000 ? timestamp / 1000 : timestamp) * 1000);
  return ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** @param {{ row: object, body: string }} source prepared transcript row */
function attachSourceEvidence(entry, source) {
  if (!entry || !source?.row) return entry;
  const sourceText = String(source.body || '').trim();
  const sourceSender = String(source.row.sender || '').trim();
  let extraction = entry.rawJson;
  try { extraction = JSON.parse(entry.rawJson); } catch { /* retain raw model output */ }
  return {
    ...entry,
    sourceText,
    sourceSender,
    rawJson: JSON.stringify({ extraction, sourceText, sourceSender }),
  };
}


import {
  isoDate,
  normalizeCurrency,
  normalizeDirection,
  parseAmountMinor,
} from './expense-utils.js';

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

function parseJson(raw, fallback) {
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

function normalizeExtractedExpense(item, fallbackDate) {
  const amountMinor = item?.amountMinor != null
    ? Math.round(Number(item.amountMinor))
    : parseAmountMinor(item?.amount ?? item?.amount_value ?? item?.value);
  // Small models often return "[message-id]" even though the prompt asks for the bare id.
  const sourceMessageId = String(
    item?.source_message_id || item?.sourceMessageId || item?.message_id || item?.messageId || item?.id || '',
  )
    .trim()
    .replace(/^\[(.+)\]$/, '$1')
    .trim();
  if (!Number.isFinite(amountMinor) || !sourceMessageId) return null;
  return {
    source: 'chat',
    sourceMessageId,
    date: isoDate(item.date, fallbackDate),
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

export async function extractChatExpenses(provider, messages, {
  date,
  excludedMessageId = null,
} = {}) {
  if (!provider?.chat) throw new Error('An AI provider is required to extract chat expenses');
  const eligible = (messages || []).filter((row) => row.messageId !== excludedMessageId);
  if (!eligible.length) return [];
  const rows = eligible.map((row) => {
    const rowDate = messageDate(row, date);
    return {
      row,
      date: rowDate,
      line: `[${row.messageId}] [${rowDate || ''}] ${row.sender || 'Unknown'}: ${row.text || row.mediaCaption || ''}`,
    };
  });
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const item of rows) {
    const size = item.line.length + 1;
    if (batch.length && (batch.length >= 20 || chars + size > 9000)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(item);
    chars += size;
  }
  if (batch.length) batches.push(batch);

  const output = [];
  for (const group of batches) {
    output.push(...await extractBatch(provider, group, date));
  }
  const validMessageIds = new Set(eligible.map((row) => String(row.messageId)));
  const byId = new Map(eligible.map((row) => [String(row.messageId), row]));
  const dateById = new Map(rows.map(({ row, date: rowDate }) => [String(row.messageId), rowDate || date]));
  const entries = output
    .map((item) => normalizeExtractedExpense(item, dateById.get(extractedSourceId(item)) || date))
    .filter((entry) => entry && validMessageIds.has(entry.sourceMessageId))
    .map((entry) => attachSourceEvidence(
      backfillReferenceFromMessage(entry, byId.get(entry.sourceMessageId)),
      byId.get(entry.sourceMessageId),
    ));
  const coveredMessageIds = new Set(entries.map((entry) => entry.sourceMessageId));
  const uncoveredRows = eligible.filter((row) => (
    looksLikeExpenseEvidence(row.text || row.mediaCaption || '')
    && !coveredMessageIds.has(String(row.messageId))
  ));
  // Models sometimes return valid JSON while silently omitting a transaction. Retry
  // just the evidence-bearing rows, then fail closed if they still cannot be extracted.
  if (uncoveredRows.length) {
    const retryRows = uncoveredRows.map((row) => ({
      row,
      line: `[${row.messageId}] [${dateById.get(String(row.messageId)) || ''}] ${row.sender || 'Unknown'}: ${row.text || row.mediaCaption || ''}`,
    }));
    const retryOutput = await extractBatch(provider, retryRows, date, 0, true);
    const retryEntries = retryOutput
      .map((item) => normalizeExtractedExpense(item, dateById.get(extractedSourceId(item)) || date))
      .filter((entry) => entry && validMessageIds.has(entry.sourceMessageId))
      .map((entry) => attachSourceEvidence(
        backfillReferenceFromMessage(entry, byId.get(entry.sourceMessageId)),
        byId.get(entry.sourceMessageId),
      ));
    entries.push(...retryEntries);
    const stillUncovered = uncoveredRows.filter((row) => (
      !retryEntries.some((entry) => entry.sourceMessageId === String(row.messageId))
    ));
    const fallbackEntries = stillUncovered
      .map((row) => deterministicExpenseFallback(row, dateById.get(String(row.messageId)) || date))
      .filter(Boolean);
    entries.push(...fallbackEntries);
    const unresolvedRows = stillUncovered.filter((row) => (
      !fallbackEntries.some((entry) => entry.sourceMessageId === String(row.messageId))
    ));
    if (unresolvedRows.length) {
      throw new Error(
        `Expense extraction could not safely read ${unresolvedRows.length} transaction-like chat message(s). `
        + 'Check that each message states a clear amount and payment direction, then retry.',
      );
    }
  }
  if (!entries.length && eligible.some((row) => looksLikeExpenseEvidence(row.text || row.mediaCaption || ''))) {
    throw new Error(
      'Expense extraction returned no usable rows even though the chat has transaction-like messages. '
      + 'Retry after checking that each expense includes a readable amount.',
    );
  }
  return entries;
}

function looksLikeExpenseEvidence(text) {
  const value = String(text || '');
  const hasAmount = /(?:₹|\b(?:rs\.?|inr|usd|eur|gbp)\s*|[$€£])\s*\d[\d,.]*|\b\d[\d,.]*\s*(?:k|thousand|lakh|lac|crore|cr)\b|\b\d[\d,.]*\b/i.test(value);
  const transactionContext = /\b(?:paid|pay|payment|spent|spend|purchase|purchased|bought|expense|expenses|cost|debit|refund(?:ed)?|reimbursed|reimbursement)\b/i.test(value);
  const advanceContext = /\badvance\b/i.test(value)
    && /\b(?:received|collected|from\s+(?:the\s+)?client|client|paid|payment)\b/i.test(value);
  return hasAmount && (transactionContext || advanceContext);
}

/** Deterministically recover a simple, explicit payment when the model omits it. */
function deterministicExpenseFallback(row, fallbackDate) {
  const text = String(row?.text || row?.mediaCaption || '').trim();
  if (!text || !row?.messageId) return null;
  const outgoing = /\b(?:paid|pay|payment|spent|spend|purchase|purchased|bought|charged|charge|debit)\b/i.test(text);
  const refund = /\b(?:refund(?:ed)?|reimbursed|reimbursement)\b/i.test(text);
  const incomingAdvance = /\badvance\b/i.test(text)
    && /\b(?:received|collected|from\s+(?:the\s+)?client|client)\b/i.test(text);
  if (!outgoing && !refund && !incomingAdvance) return null;

  const currencyAmounts = [...text.matchAll(/(?:₹|\b(?:rs\.?|inr|usd|eur|gbp|cad|aud)\s*|[$€£])\s*\(?\s*-?\d[\d,]*(?:[.,]\d{1,2})?\)?(?:\s*(?:k|thousand|l|lac|lakh|m|million|cr|crore))?/gi)];
  let amountToken = currencyAmounts.length === 1 ? currencyAmounts[0][0] : null;
  if (!amountToken && currencyAmounts.length === 0 && (outgoing || refund || incomingAdvance)) {
    const amountAfterVerb = text.match(/\b(?:paid|pay|payment|spent|spend|purchase|purchased|bought|charged|charge|debit|refund(?:ed)?|reimbursed|reimbursement|received|collected|advance)\b[^.!?]{0,60}?\b(\d[\d,]*(?:\.\d{1,2})?\s*(?:k|thousand|l|lac|lakh|m|million|cr|crore)?)(?![/.]\d)\b/i);
    if (amountAfterVerb) amountToken = amountAfterVerb[1].trim();
  }
  if (!amountToken) return null;
  const amountMinor = parseAmountMinor(amountToken);
  if (amountMinor == null || amountMinor === 0) return null;

  const reference = text.match(/\b(?:ref(?:erence)?|voucher|invoice|bill)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{2,})\b/i)?.[1] || '';
  return attachSourceEvidence({
    source: 'chat',
    sourceMessageId: String(row.messageId),
    date: messageDate(row, fallbackDate),
    amountMinor: Math.abs(amountMinor),
    currency: normalizeCurrency(amountToken),
    direction: refund || incomingAdvance ? 'credit' : 'debit',
    description: text,
    payee: '',
    category: incomingAdvance ? 'client advance' : 'other',
    reference,
    rawJson: JSON.stringify({ deterministicFallback: true }),
  }, row);
}

function expensePrompt(group, date, correction = false) {
  const transcript = group.map((item) => item.line).join('\n');
  return `Extract expense transactions from this site or business WhatsApp transcript. The messages may describe any industry, goods, services, category, language, or writing style. The selected Excel sheet provides the business context; do not assume construction-specific categories.

- Return ONLY one valid JSON array, with no markdown fences, prose, or analysis.
- Each item must contain: source_message_id, amount, currency, direction, date, payee, category, description, reference.
- source_message_id must exactly match one ID shown in square brackets; never invent, shorten, or combine IDs.
- amount must be a numeric value in major currency units, without currency symbols; expand only unambiguous shorthand such as 1.5k, lakh, or crore.
- direction is "debit" for a payment or expense and "credit" for a refund, reimbursement, or client advance received. Include client advances as credit transactions to compare with the sheet; omit other revenue and unrelated receipts.
- Preserve categories and descriptions as stated, including unfamiliar categories. If no category is stated, use "other"; do not force rows into a fixed list.
- Use the date label attached to each message; if absent, use ${date || 'the spreadsheet business date'}.
- Keep separate payments as separate items, including multiple explicit expenses in one message. Do not calculate totals or infer amounts, payees, or dates.
- Omit non-expense discussion and the submitted spreadsheet itself, except that client advances received must be included as credit transactions.
${correction ? '- If there are no expenses, return exactly []. Ensure every quote, comma, and bracket makes the JSON valid.' : ''}

Transcript:
${transcript}`;
}

async function extractBatch(provider, group, date, depth = 0, correction = false) {
  const first = await provider.chat([{ role: 'user', content: expensePrompt(group, date, correction) }], {
    temperature: 0,
    maxTokens: 2048,
    numCtx: 8192,
  });
  let parsed = parseJson(first, null);
  if (!Array.isArray(parsed) || (parsed.length === 0 && group.some(({ row }) => (
    looksLikeExpenseEvidence(row.text || row.mediaCaption || '')
  )))) {
    const retry = await provider.chat([{ role: 'user', content: expensePrompt(group, date, true) }], {
      temperature: 0,
      maxTokens: 4096,
      numCtx: 8192,
    });
    parsed = parseJson(retry, null);
  }
  if (Array.isArray(parsed)) return parsed;
  if (group.length > 1 && depth < 8) {
    const middle = Math.ceil(group.length / 2);
    const left = await extractBatch(provider, group.slice(0, middle), date, depth + 1);
    const right = await extractBatch(provider, group.slice(middle), date, depth + 1);
    return [...left, ...right];
  }
  const model = [provider?.name, provider?.model].filter(Boolean).join('/');
  throw new Error(`Expense extraction returned invalid JSON after retry${model ? ` (${model})` : ''}.`);
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

function attachSourceEvidence(entry, messageRow) {
  if (!entry || !messageRow) return entry;
  const sourceText = String(messageRow.text || messageRow.mediaCaption || '').trim();
  const sourceSender = String(messageRow.sender || '').trim();
  let extraction = entry.rawJson;
  try { extraction = JSON.parse(entry.rawJson); } catch { /* retain raw model output */ }
  return {
    ...entry,
    sourceText,
    sourceSender,
    rawJson: JSON.stringify({ extraction, sourceText, sourceSender }),
  };
}


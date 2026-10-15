import {
  isoDate,
  normalizeCurrency,
  normalizeDirection,
  parseAmountMinor,
} from './expense-utils.js';
import { GROUNDING_PROMPT_RULES } from '../search/grounding.js';

function parseJson(raw, fallback) {
  const text = String(raw || '').trim();
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  try {
    if (arrayStart >= 0 && arrayEnd > arrayStart) return JSON.parse(text.slice(arrayStart, arrayEnd + 1));
    if (objectStart >= 0 && objectEnd > objectStart) return JSON.parse(text.slice(objectStart, objectEnd + 1));
  } catch { /* invalid model output */ }
  return fallback;
}

export function dayBoundsFromTimestamp(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
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
  const amountMinor = parseAmountMinor(item?.amount);
  const sourceMessageId = String(item?.source_message_id || item?.sourceMessageId || '').trim();
  if (amountMinor == null || !sourceMessageId) return null;
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
  const transcript = eligible.map((row) => (
    `[${row.messageId}] ${row.sender || 'Unknown'}: ${row.text || row.mediaCaption || ''}`
  )).join('\n');

  const prompt = `Extract every construction-site expense, payment, advance, reimbursement, refund, or credit from this WhatsApp transcript for ${date}.

${GROUNDING_PROMPT_RULES}
- Return ONLY a valid JSON array.
- Each item must contain: source_message_id, amount, currency, direction, date, payee, category, description, reference.
- source_message_id must exactly match the ID in square brackets containing the evidence.
- direction is "debit" for money paid/spent and "credit" for money received/refunded.
- Valid categories: labour, fuel, material, transport, equipment, food, other.
- Keep separate payments as separate items. Do not calculate or infer missing amounts.
- Omit non-expense discussion and the submitted spreadsheet itself.

Transcript:
${transcript}`;
  const raw = await provider.chat([{ role: 'user', content: prompt }], {
    temperature: 0,
    maxTokens: 2048,
  });
  const parsed = parseJson(raw, []);
  if (!Array.isArray(parsed)) throw new Error('Expense extraction returned invalid JSON');
  const validMessageIds = new Set(eligible.map((row) => String(row.messageId)));
  return parsed
    .map((item) => normalizeExtractedExpense(item, date))
    .filter((entry) => entry && validMessageIds.has(entry.sourceMessageId));
}


const HEADER_ALIASES = {
  date: ['date', 'expense date', 'transaction date', 'txn date', 'paid on', 'bill date', 'day'],
  amount: ['amount', 'expense amount', 'paid amount', 'transaction amount', 'value', 'total'],
  debitAmount: ['debit', 'debit amount', 'withdrawal', 'outflow', 'paid out'],
  creditAmount: ['credit', 'credit amount', 'deposit', 'inflow', 'received'],
  description: ['description', 'details', 'particulars', 'narration', 'remarks', 'purpose', 'expense', 'item', 'service'],
  payee: ['payee', 'paid to', 'vendor', 'supplier', 'merchant', 'recipient', 'employee', 'party', 'account name', 'name'],
  category: ['category', 'expense type', 'type', 'head', 'account head', 'expense head', 'ledger'],
  direction: ['direction', 'debit credit', 'dr cr', 'transaction type'],
  reference: ['reference', 'reference no', 'ref no', 'voucher no', 'bill no', 'receipt no', 'transaction id', 'invoice no'],
  currency: ['currency', 'ccy'],
};

export const CANONICAL_EXPENSE_FIELDS = Object.freeze(Object.keys(HEADER_ALIASES));

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function canonicalHeader(value) {
  const normalized = normalizeText(value);
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some((alias) => normalizeText(alias) === normalized)) return field;
  }
  return null;
}

export function parseAmountMinor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
  let raw = String(value ?? '').trim();
  if (!raw) return null;
  let multiplier = 1;
  const suffix = raw.match(/\s*(k|thousand|l|lac|lakh|m|million|cr|crore)\s*$/i);
  if (suffix) {
    const unit = suffix[1].toLowerCase();
    multiplier = ['k', 'thousand'].includes(unit) ? 1_000
      : ['l', 'lac', 'lakh'].includes(unit) ? 100_000
        : ['m', 'million'].includes(unit) ? 1_000_000 : 10_000_000;
    raw = raw.slice(0, suffix.index).trim();
  }
  const negative = /^\s*\(.*\)\s*$/.test(raw)
    || /^\s*-/.test(raw)
    || /-\s*$/.test(raw);
  let numeric = raw.replace(/[^\d.,]/g, '');
  if (!numeric || !/\d/.test(numeric)) return null;
  const comma = numeric.lastIndexOf(',');
  const dot = numeric.lastIndexOf('.');
  let decimal = -1;
  if (comma >= 0 && dot >= 0) decimal = Math.max(comma, dot);
  else if (comma >= 0 || dot >= 0) {
    const separator = Math.max(comma, dot);
    const trailingDigits = numeric.length - separator - 1;
    const separatorCount = (numeric.match(comma >= 0 ? /,/g : /\./g) || []).length;
    if (trailingDigits > 0 && trailingDigits <= 2) decimal = separator;
    else if (separatorCount === 1 && trailingDigits === 3) decimal = -1;
  }
  if (decimal >= 0) {
    const fraction = numeric.slice(decimal + 1).replace(/\D/g, '');
    const whole = numeric.slice(0, decimal).replace(/\D/g, '');
    numeric = `${whole || '0'}.${fraction}`;
  } else {
    numeric = numeric.replace(/\D/g, '');
  }
  const parsed = Number(numeric) * multiplier;
  if (!Number.isFinite(parsed)) return null;
  return Math.round(Math.abs(parsed) * 100) * (negative ? -1 : 1);
}

/** Devanagari digits (०-९) → ASCII so Hindi-typed amounts parse like English ones. */
export function normalizeDigits(value) {
  return String(value ?? '').replace(/[०-९]/g, (digit) => String(digit.charCodeAt(0) - 0x0966));
}

/**
 * Remove numbers that are never money: attachment names, URLs, Indian mobile numbers
 * (10 digits starting 6-9, optional +91), long transaction/UTR/account IDs, dates, and times.
 */
export function stripNonAmountNumbers(value) {
  return normalizeDigits(value)
    .replace(/<attached:[^>]*>/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b[\w.()-]+\.(?:jpe?g|png|webp|gif|heic|pdf|xlsx|xls|csv|docx?|opus|ogg|mp3|mp4|vcf)\b/gi, ' ')
    .replace(/(?:\+91|(?<!\d)91)[\s-]?[6-9](?:[\s-]?\d){9}(?!\d)/g, ' ')
    .replace(/(?<!\d)[6-9](?:\d{9}|\d{4}[\s-]\d{5}|\d{3}[\s-]\d{3}[\s-]\d{3}|\d{2}[\s-]\d{3}[\s-]\d{4}|\d{3}[\s-]\d{6})(?!\d)/g, ' ')
    .replace(/(?<!\d)\d{11,}(?!\d)/g, ' ')
    .replace(/\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g, (token) => (/\d/.test(token) ? ' ' : token))
    .replace(/(?<!\d)\d{1,4}[./-]\d{1,2}[./-]\d{2,4}(?!\d)/g, ' ')
    .replace(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?/gi, ' ');
}

/** Every amount (minor units) literally written in the text, after dropping non-money numbers. */
export function amountCandidatesMinor(value) {
  const out = new Set();
  const clean = stripNonAmountNumbers(value);
  for (const match of clean.matchAll(/\d[\d,]*(?:\.\d+)?(?:\s*(?:k|thousand|lakh|lac|cr|crore)\b)?/gi)) {
    const amount = parseAmountMinor(match[0]);
    if (amount) out.add(Math.abs(amount));
  }
  return out;
}

/** True when the amount is literally present in the text (guards against model-invented numbers). */
export function amountGroundedInText(amountMinor, value) {
  return amountCandidatesMinor(value).has(Math.abs(Number(amountMinor)));
}

/**
 * Looser check for document text, where printouts glue columns together
 * ("Diesel hydra 5000255025" = amount + fee + total): the amount's digits must appear somewhere.
 */
export function amountAppearsInDocument(amountMinor, value) {
  const minor = Math.abs(Number(amountMinor));
  if (!Number.isFinite(minor) || minor === 0) return false;
  const digits = normalizeDigits(value).replace(/(?<=\d)[,\s](?=\d{2,3}\b)/g, '');
  const major = minor / 100;
  const forms = new Set([String(major), major.toFixed(2)]);
  return [...forms].some((form) => digits.includes(form));
}

export function normalizeDirection(value, amountMinor = null, header = '') {
  const text = normalizeText(value || header);
  if (/\b(credit|cr|refund|received|receipt)\b/.test(text)) return 'credit';
  if (/\b(debit|dr|paid|expense|payment)\b/.test(text)) return 'debit';
  return Number(amountMinor) < 0 ? 'credit' : 'debit';
}

const ISO_CURRENCIES = new Set(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : []);

export function normalizeCurrency(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw || /₹|\bRS\.?\b|\bINR\b|\bRUPEES?\b/.test(raw)) return 'INR';
  const code = raw.match(/\b([A-Z]{3})\b/);
  if (code && (!ISO_CURRENCIES.size || ISO_CURRENCIES.has(code[1]))) return code[1];
  if (raw.includes('$')) return 'USD';
  if (raw.includes('€') || /\bEUROS?\b/.test(raw)) return 'EUR';
  if (raw.includes('£') || /\bPOUNDS?\b/.test(raw)) return 'GBP';
  if (raw.includes('¥') || /\bYEN\b/.test(raw)) return 'JPY';
  // Model noise ("diye", "upi") is not a currency; keep the existing INR default.
  return 'INR';
}

export function isoDate(value, fallback = null) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    excelEpoch.setUTCDate(excelEpoch.getUTCDate() + Math.floor(value));
    return excelEpoch.toISOString().slice(0, 10);
  }
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const ymd = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (ymd) return validIsoDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3])) || fallback;
  const dmy = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return validIsoDate(Number(year), Number(dmy[2]), Number(dmy[1])) || fallback;
  }
  const named = raw.match(/^(\d{1,2})[\s-]+([a-z]{3,9})[\s,-]+(\d{2,4})$/i)
    || raw.match(/^([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/i);
  if (named) {
    const monthName = named[2].length >= 3 && /^\d/.test(named[1]) ? named[2] : named[1];
    const day = Number(/^\d/.test(named[1]) ? named[1] : named[2]);
    const yearValue = Number(named[3]);
    const year = named[3].length === 2 ? Number(`20${named[3]}`) : yearValue;
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
      .findIndex((prefix) => monthName.toLowerCase().startsWith(prefix)) + 1;
    return validIsoDate(year, month, day) || fallback;
  }
  return fallback;
}

function validIsoDate(year, month, day) {
  if (year < 1000 || year > 9999) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function expenseIdentity(entry, { includeAmount = true } = {}) {
  const parts = [
    entry.date || '',
    normalizeText(entry.payee || entry.description),
    entry.direction || 'debit',
    entry.currency || 'INR',
  ];
  if (includeAmount) parts.push(String(Math.abs(Number(entry.amountMinor) || 0)));
  return parts.join('|');
}


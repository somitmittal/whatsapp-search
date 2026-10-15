const HEADER_ALIASES = {
  date: ['date', 'expense date', 'transaction date', 'txn date', 'paid on', 'day'],
  amount: ['amount', 'expense amount', 'paid amount', 'value', 'total', 'debit', 'credit'],
  description: ['description', 'details', 'particulars', 'narration', 'remarks', 'purpose', 'expense'],
  payee: ['payee', 'paid to', 'vendor', 'supplier', 'labourer', 'recipient', 'party'],
  category: ['category', 'expense type', 'type', 'head', 'account head'],
  direction: ['direction', 'debit credit', 'dr cr', 'transaction type'],
  reference: ['reference', 'reference no', 'ref no', 'voucher no', 'bill no', 'receipt no', 'transaction id'],
  currency: ['currency', 'ccy'],
};

export const CANONICAL_EXPENSE_FIELDS = Object.freeze(Object.keys(HEADER_ALIASES));

export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
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
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const negative = /^\s*\(.*\)\s*$/.test(raw) || /(?:^|\s)-\s*\d/.test(raw);
  const cleaned = raw.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(Math.abs(parsed) * 100) * (negative ? -1 : 1);
}

export function normalizeDirection(value, amountMinor = null, header = '') {
  const text = normalizeText(value || header);
  if (/\b(credit|cr|refund|received|receipt)\b/.test(text)) return 'credit';
  if (/\b(debit|dr|paid|expense|payment)\b/.test(text)) return 'debit';
  return Number(amountMinor) < 0 ? 'credit' : 'debit';
}

export function normalizeCurrency(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw || raw === '₹' || raw === 'RS' || raw === 'RS.' || raw === 'INR') return 'INR';
  if (raw === '$') return 'USD';
  if (raw === '€') return 'EUR';
  return raw.replace(/[^A-Z]/g, '').slice(0, 3) || 'INR';
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
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  const dmy = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${year}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  return fallback;
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


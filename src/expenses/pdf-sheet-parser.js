import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { isoDate, normalizeCurrency, parseAmountMinor } from './expense-utils.js';

const require = createRequire(import.meta.url);

function parsePdfBuffer(buffer) {
  // Use the lib entry — the package root runs a debug open of a missing test PDF.
  const fn = require('pdf-parse/lib/pdf-parse.js');
  return fn(buffer);
}

export async function extractPdfText(buffer) {
  const data = await parsePdfBuffer(buffer);
  return String(data?.text || '');
}

/** Filenames used for daily Phone pay / Google Sheet expense printouts in site chats. */
export function looksLikeExpensePdfName(name) {
  const n = basename(String(name || '')).toLowerCase().replace(/[_-]+/g, ' ');
  if (!n.endsWith('.pdf')) return false;
  if (n.startsWith('searchable-expense-report')) return false;
  return /(?:phone\s*pay|phn\s*pay|phon\s*pay|phonpay|daily\s*exp)/i.test(n);
}

const SUMMARY_LINE = /^\s*total\s+(?:dena|lena)\s+hai\b/i;
const DATE_PREFIX = /^(\d{1,2}\.\d{1,2}\.\d{2,4})/;

/**
 * Peel amount + tax + total from a glued numeric suffix where amount + tax ≈ total.
 * Phone-pay Google Sheet PDFs concatenate these without separators.
 */
export function peelAmountTaxTotal(nums) {
  const raw = String(nums || '').replace(/,/g, '');
  if (!/^\d[\d.]*$/.test(raw) || raw.length < 3) return null;
  const cands = [];
  for (let i = 1; i < raw.length - 1; i += 1) {
    for (let j = i + 1; j < raw.length; j += 1) {
      const a = raw.slice(0, i);
      const b = raw.slice(i, j);
      const c = raw.slice(j);
      if (!/^\d+(\.\d+)?$/.test(a) || !/^\d+(\.\d+)?$/.test(b) || !/^\d+(\.\d+)?$/.test(c)) continue;
      if ((a.length > 1 && a.startsWith('0')) || (c.length > 1 && c.startsWith('0'))) continue;
      const amount = Number(a);
      const tax = Number(b);
      const total = Number(c);
      if (!(amount >= 100 && total > 0 && tax >= 0 && tax <= amount)) continue;
      if (Math.abs(amount + tax - total) > 1.01) continue;
      const score = (/\.\d{1,2}$/.test(b) ? 3 : 0)
        + (tax <= amount * 0.28 ? 2 : 0)
        + Math.min(String(Math.trunc(amount)).length, 6);
      cands.push({ amount, tax, total, score });
    }
  }
  cands.sort((x, y) => y.score - x.score || y.amount - x.amount);
  return cands[0] || null;
}

/**
 * One dated expense line from a Phone-pay sheet PDF, or null.
 * @returns {{ dateRaw: string, description: string, amount: number, tax: number, total: number } | null}
 */
export function parsePhonePayExpenseLine(line) {
  const text = String(line || '').replace(/\s+/g, ' ').trim();
  if (!text || SUMMARY_LINE.test(text)) return null;
  const dateMatch = text.match(DATE_PREFIX);
  if (!dateMatch) return null;
  const dateRaw = dateMatch[1];
  const rest = text.slice(dateMatch[0].length).trim();
  if (!rest || !/[A-Za-z]/.test(rest)) return null;

  const compact = rest.replace(/\s+/g, '');
  let best = null;
  for (let descLen = compact.length - 3; descLen >= 1; descLen -= 1) {
    const descCompact = compact.slice(0, descLen);
    const nums = compact.slice(descLen);
    if (!/[A-Za-z]/.test(descCompact) || !/^\d/.test(nums)) continue;
    const peeled = peelAmountTaxTotal(nums);
    if (!peeled) continue;
    const score = peeled.score + (descLen > 3 ? 1 : 0);
    if (!best || score > best.score) {
      best = {
        dateRaw,
        description: spacedPrefix(rest, descLen) || descCompact,
        amount: peeled.amount,
        tax: peeled.tax,
        total: peeled.total,
        score,
      };
    }
  }
  return best;
}

/** First `n` non-whitespace characters of `spaced`, keeping original spaces. */
function spacedPrefix(spaced, n) {
  let out = '';
  let count = 0;
  for (const ch of String(spaced || '')) {
    if (/\s/.test(ch)) {
      if (count > 0) out += ch;
      continue;
    }
    if (count >= n) break;
    out += ch;
    count += 1;
  }
  return out.trim();
}

function dmyToIso(dateRaw, fallbackDate) {
  return isoDate(String(dateRaw || '').replace(/\./g, '-'), fallbackDate);
}

const BALANCE_LABEL = /\b(?:totals?|balance|baki|remaining|opening|closing|dena\s+hai|lena\s+hai)\b/i;
const DATED_TEXT_LINE = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\s*\S*[A-Za-z]/;

/**
 * Deterministic read of a Phone-pay / hisab printout's text.
 * `complete` is true only when every dated line with text was parsed, so callers can
 * fall back to an AI read for layouts this parser does not understand.
 */
export function parsePhonePayPdfText(text, { fallbackDate = null } = {}) {
  const lines = String(text || '').split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const entries = [];
  let rowNumber = 0;
  let datedLines = 0;
  let parsedDated = 0;
  let lastDate = fallbackDate;
  for (const line of lines) {
    if (DATED_TEXT_LINE.test(line) && !SUMMARY_LINE.test(line.replace(DATE_PREFIX, ''))
      && !/^totals?\b/i.test(line.replace(DATE_PREFIX, '').trim())) {
      datedLines += 1;
    }
    const parsed = parsePhonePayExpenseLine(line);
    if (parsed) {
      lastDate = dmyToIso(parsed.dateRaw, lastDate);
      if (/^totals?\b/i.test(parsed.description)) continue;
      parsedDated += 1;
      const amountMinor = parseAmountMinor(parsed.amount);
      if (amountMinor == null || amountMinor === 0) continue;
      rowNumber += 1;
      entries.push(phonePayEntry(rowNumber, {
        date: lastDate,
        description: parsed.description,
        payee: '',
        amountMinor: Math.abs(amountMinor),
        direction: 'debit',
        rawJson: JSON.stringify(parsed),
      }));
      continue;
    }
    const dated = line.match(DATE_PREFIX);
    if (dated) {
      lastDate = dmyToIso(dated[1], lastDate);
      continue;
    }
    // Standalone transfer lines: "Santosh bhaiya -40000" (keep the sign; skip totals and balances).
    const transfer = line.match(/^([A-Za-z][A-Za-z0-9 .()/]{1,60}?)\s+(-?\d[\d,]*(?:\.\d+)?)$/);
    if (!transfer || BALANCE_LABEL.test(transfer[1])) continue;
    const amountMinor = parseAmountMinor(transfer[2]);
    if (amountMinor == null || amountMinor === 0) continue;
    rowNumber += 1;
    entries.push(phonePayEntry(rowNumber, {
      date: lastDate,
      description: transfer[1].trim(),
      payee: transfer[1].trim(),
      amountMinor: Math.abs(amountMinor),
      direction: amountMinor < 0 ? 'credit' : 'debit',
      rawJson: JSON.stringify({ line }),
    }));
  }
  return {
    complete: entries.length > 0 && parsedDated === datedLines,
    sheet: {
      worksheetName: 'Phone pay PDF',
      worksheetNames: ['Phone pay PDF'],
      headerRow: 1,
      headers: PHONE_PAY_HEADERS,
      mapping: { date: 0, description: 1, amount: 2 },
      entries,
    },
  };
}

const PHONE_PAY_HEADERS = ['Date', 'Description', 'Amount', 'Tax', 'Total'];

function phonePayEntry(sheetRow, fields) {
  return {
    source: 'sheet',
    sheetRow,
    worksheetName: 'Phone pay PDF',
    sourceHeaders: PHONE_PAY_HEADERS,
    currency: normalizeCurrency('INR'),
    category: '',
    reference: '',
    ...fields,
  };
}

/**
 * Parse a Phone-pay / daily-expense Google Sheet PDF into the same shape as parseExpenseWorkbook.
 */
export async function parseExpensePdf(filePath, { fallbackDate = null, fileName = null } = {}) {
  const text = await extractPdfText(readFileSync(filePath));
  const label = basename(String(fileName || filePath || 'expenses.pdf'));
  if (!looksLikeExpensePdfName(label) && !/total\s+(?:dena|lena)\s+hai/i.test(text)) {
    throw new Error('PDF does not look like a Phone pay / daily expense sheet');
  }
  const { sheet } = parsePhonePayPdfText(text, { fallbackDate });
  if (!sheet.entries.length) throw new Error('Could not read expense rows from the PDF');
  return sheet;
}

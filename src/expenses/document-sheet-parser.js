import AdmZip from 'adm-zip';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  amountAppearsInDocument,
  amountCandidatesMinor,
  isoDate,
  normalizeCurrency,
  normalizeDigits,
  parseAmountMinor,
} from './expense-utils.js';
import { extractPdfText } from './pdf-sheet-parser.js';
import { BATCH_MAX_CHARS, expensesSchema, parseJsonRows, rowObject } from './chat-expense-extractor.js';

const DOC_FIELDS = ['date', 'description', 'payee', 'amount', 'direction', 'category', 'reference'];
const DOC_SCHEMA = expensesSchema(DOC_FIELDS, ['date', 'description', 'amount']);

export const DOCUMENT_SHEET_EXTENSIONS = Object.freeze(['.xlsx', '.xlsm', '.csv', '.tsv', '.txt', '.pdf', '.docx']);
export const IMAGE_SHEET_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.webp']);
const ALL_EXTENSIONS = [...DOCUMENT_SHEET_EXTENSIONS, ...IMAGE_SHEET_EXTENSIONS];
const IMAGE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const AI_HEADERS = ['Date', 'Description', 'Payee', 'Amount', 'Direction', 'Reference'];
const AI_MAPPING = { date: 0, description: 1, payee: 2, amount: 3, direction: 4, reference: 5 };

/** Extension from the WhatsApp file name when present (media paths are often renamed), else the path. */
export function documentExtension(fileName, filePath) {
  const pattern = new RegExp(`\\.(${ALL_EXTENSIONS.map((ext) => ext.slice(1)).join('|')})\\b`, 'i');
  const named = String(fileName || '').match(pattern);
  if (named) return `.${named[1].toLowerCase()}`;
  return extname(String(filePath || '')).toLowerCase();
}

export function isSupportedSheetExtension(ext) {
  return ALL_EXTENSIONS.includes(String(ext || '').toLowerCase());
}

function docxText(filePath) {
  const xml = new AdmZip(filePath).readAsText('word/document.xml');
  if (!xml) throw new Error('The Word document has no readable body');
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:(?:p|tr)>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

async function workbookText(filePath, ext) {
  const workbook = new ExcelJS.Workbook();
  if (ext === '.csv') await workbook.csv.readFile(filePath);
  else await workbook.xlsx.readFile(filePath);
  const lines = [];
  for (const worksheet of workbook.worksheets) {
    lines.push(`# Sheet: ${worksheet.name}`);
    worksheet.eachRow((row) => {
      const values = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const value = cell.value;
        if (value instanceof Date) values.push(isoDate(value));
        else if (value && typeof value === 'object') values.push(value.result ?? value.text ?? (value.richText || []).map((x) => x.text).join(''));
        else values.push(value ?? '');
      });
      if (values.some((value) => String(value).trim())) lines.push(values.join('\t'));
    });
  }
  return lines.join('\n');
}

function providerCannotSee(text) {
  const value = String(text || '').trim();
  return !value || (value.startsWith('[') && /vision|multimodal|not supported|not available|use .* for (?:media|images)/i.test(value));
}

/** Plain text of any supported document; images are read through the provider's vision caption. */
export async function extractDocumentText(filePath, { ext, provider = null } = {}) {
  if (ext === '.pdf') return extractPdfText(readFileSync(filePath));
  if (ext === '.docx') return docxText(filePath);
  if (ext === '.txt' || ext === '.tsv') return readFileSync(filePath, 'utf8');
  if (ext === '.csv' || ext === '.xlsx' || ext === '.xlsm') return workbookText(filePath, ext === '.csv' ? '.csv' : '.xlsx');
  if (IMAGE_SHEET_EXTENSIONS.includes(ext)) {
    if (typeof provider?.caption !== 'function') throw new Error('The configured AI model cannot read images');
    const text = await provider.caption(readFileSync(filePath).toString('base64'), IMAGE_MIME[ext]);
    if (providerCannotSee(text)) {
      throw new Error('The configured AI model cannot read images — pick a vision model to reconcile a photographed sheet');
    }
    return text;
  }
  throw new Error(`Unsupported expense file type ${ext || '(unknown)'}; send .xlsx, .csv, .pdf, .docx, .txt, or a photo of the sheet`);
}

function chunkLines(text) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const line of String(text || '').split('\n')) {
    if (current.length && size + line.length + 1 > BATCH_MAX_CHARS) {
      chunks.push(current.join('\n'));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.join('').trim()) chunks.push(current.join('\n'));
  return chunks;
}

function documentPrompt(chunk, fallbackDate, label) {
  return `Extract every transaction row from this expense document "${label}". It may be a ledger, a Phone pay / hisab printout, a bank or UPI statement, a receipt, a bill, or a photo of a handwritten sheet, in English, Hindi, or Hinglish. The text was extracted from a PDF or image, so columns may be glued together or split across lines.

Return ONLY one JSON object, no markdown or prose: {"expenses": [ ... ]} with one item per transaction row. Each item: date, description, payee, amount, direction, category, reference.

Rules:
- One item per transaction line. Keep repeated identical lines as separate items.
- amount: the transaction's base amount as printed. When a line glues amount, fee/commission and total together (e.g. "Diesel hydra 5000255025" = 5000 + 25 + 5025), use the first (base) amount. Never invent or add up amounts.
- direction: "debit" for money paid out; "credit" for money received or added (negative amounts like "-40000", "received", "jama", deposits, funds from a person).
- date: YYYY-MM-DD. Dates are day-first (14.10.26 = 2026-10-14). A line without a date takes the nearest preceding dated line's date${fallbackDate ? `; if none, use ${fallbackDate}` : ''}.
- Skip headers, totals, subtotals, opening/closing/running balances ("Total dena hai", "Total lena hai", "Lena baki", "Remaining balance"), page numbers, phone numbers, and IDs.
- A receipt or bill for one payment is one item with its paid amount; put its bill/transaction number in reference.
- If there are no transactions, return {"expenses": []}.

Document text:
${chunk}`;
}

async function askForRows(provider, chunk, fallbackDate, label) {
  const options = { temperature: 0, maxTokens: 4096, numCtx: 8192, jsonSchema: DOC_SCHEMA };
  let parsed = parseJsonRows(await provider.chat([{ role: 'user', content: documentPrompt(chunk, fallbackDate, label) }], options));
  if (!Array.isArray(parsed)) {
    const correction = `${documentPrompt(chunk, fallbackDate, label)}\n\nYour previous answer was not valid. Return ONLY the JSON object {"expenses": [...]}.`;
    parsed = parseJsonRows(await provider.chat([{ role: 'user', content: correction }], options));
  }
  if (!Array.isArray(parsed)) throw new Error(`The AI model could not read rows from ${label}`);
  return parsed.map((item) => rowObject(item, DOC_FIELDS));
}

const CREDIT_WORDS = /\b(?:received|recd|jama|credit|cr|deposit(?:ed)?|refund(?:ed)?|mila|mile|prapt)\b/i;

const LINE_DATE = /^\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/;

function amountForms(amountMinor) {
  const major = Math.abs(amountMinor) / 100;
  return [...new Set([String(major), major.toFixed(2)])];
}

/**
 * The printed line a model row came from: first unused line containing the description's
 * leading words. Returns { index, line, hasAmount } or null when no line names the row.
 */
function documentLine(lines, used, description, amountMinor) {
  const words = normalizeDigits(description).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2).slice(0, 2);
  if (!words.length) return null;
  const forms = amountForms(amountMinor);
  let named = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (used.has(index)) continue;
    const lower = lines[index].toLowerCase();
    if (!words.every((word) => lower.includes(word))) continue;
    const hasAmount = forms.some((form) => lines[index].replace(/,/g, '').includes(form));
    if (hasAmount) return { index, line: lines[index], hasAmount };
    named ??= { index, line: lines[index], hasAmount: false };
  }
  return named;
}

/**
 * Paid vs received from the printed text — a minus sign before the amount or credit
 * wording — rather than from the model, which small models get wrong.
 */
function directionFromLine(line, amountMinor) {
  const compact = String(line || '').replace(/,/g, '');
  const signed = amountForms(amountMinor).some((form) => new RegExp(`-\\s*${form.replace('.', '\\.')}(?!\\d)`).test(compact));
  return signed || CREDIT_WORDS.test(line || '') ? 'credit' : 'debit';
}

function lineWithAmount(lines, amountMinor) {
  const forms = amountForms(amountMinor);
  return lines.find((line) => forms.some((form) => line.replace(/,/g, '').includes(form))) || '';
}

/**
 * AI read of any expense document's text into sheet entries. Amounts must appear in the
 * document text, and 10-digit mobile numbers are rejected, so invented rows are dropped.
 */
export async function extractSheetRowsWithModel(provider, text, { fallbackDate = null, label = 'expense document' } = {}) {
  if (!provider?.chat) throw new Error('Configure an AI provider to read this expense file');
  const source = normalizeDigits(text);
  if (!source.trim()) throw new Error(`No readable text found in ${label}`);
  const lines = source.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const side = sideColumns(lines);
  const outputs = await Promise.all(chunkLines(withoutSideColumns(lines, side).join('\n'))
    .map((chunk) => askForRows(provider, chunk, fallbackDate, label)));
  const usedLines = new Set();
  const entries = [];
  const addRows = (items, { requirePrintedLine = false } = {}) => {
    for (const item of items) {
      const entry = documentEntry(item, { source, lines, side, usedLines, fallbackDate, label, requirePrintedLine });
      if (entry) entries.push({ ...entry, sheetRow: entries.length + 1 });
    }
  };
  addRows(outputs.flat());
  // Small models skip lines; give the printed transaction lines no row came from one more pass.
  const missed = lines.filter((line, index) => !usedLines.has(index) && looksLikeTransactionLine(line));
  if (missed.length) {
    const retry = await askForRows(provider, withoutSideColumns(missed, side).join('\n'), fallbackDate, label).catch(() => []);
    addRows(retry, { requirePrintedLine: true });
  }
  if (!entries.length) throw new Error(`Could not find any expense rows in ${label}`);
  return {
    worksheetName: basename(label),
    worksheetNames: [basename(label)],
    headerRow: 1,
    headers: AI_HEADERS,
    mapping: AI_MAPPING,
    entries,
    readBy: 'ai',
  };
}

const NUMBER_ONLY_LINE = /^[\d.,\s]+$/;
const TRAILING_RUN = /([\d.]+)$/;

/**
 * Number-only lines (fee/commission columns a PDF printed beside the rows) when most
 * text rows already carry their own amount; columns laid out as separate lines don't qualify.
 */
function sideColumns(lines) {
  const textRows = lines.filter((line) => /\p{L}{2}/u.test(line) && !NON_TRANSACTION_LINE.test(line));
  const withAmount = textRows.filter((line) => amountCandidatesMinor(line).size > 0).length;
  if (!textRows.length || withAmount * 2 < textRows.length) return new Set();
  return new Set(lines.filter((line) => NUMBER_ONLY_LINE.test(line) && !LINE_DATE.test(line)).map((line) => line.replace(/[\s,]/g, '')));
}

/** Drops side-column lines and cuts a side-column block glued onto the end of a row. */
function withoutSideColumns(lines, side = sideColumns(lines)) {
  if (!side.size) return lines.map(splitGluedProduct);
  return lines.filter((line) => !side.has(line.replace(/[\s,]/g, ''))).map(splitGluedProduct).map((line) => {
    const run = line.replace(/,/g, '').match(TRAILING_RUN)?.[1] || '';
    const glued = [...side].find((block) => run.length > block.length && run.endsWith(block) && /\d$/.test(run.slice(0, -block.length)));
    return glued ? line.replace(/,/g, '').slice(0, -glued.length) : line;
  });
}

/** "4*5002000" → "4*500 = 2000" when the glued digits split into a rate and its exact product. */
function splitGluedProduct(line) {
  return line.replace(/(\d+)\s*([*x×])\s*(\d{3,})/giu, (whole, count, op, digits) => {
    for (let cut = 1; cut < digits.length; cut += 1) {
      const rate = digits.slice(0, cut);
      const total = digits.slice(cut);
      if (!total.startsWith('0') && Number(count) * Number(rate) === Number(total)) return `${count}${op}${rate} = ${total}`;
    }
    return whole;
  });
}

/** "4*500 … grg3000": an amount printed only as a rate operand isn't the row total; the trailing one is. */
function rateOperandOnly(line, amountMinor) {
  const compact = String(line || '').replace(/,/g, '');
  const hits = amountForms(amountMinor).flatMap((form) => [...compact.matchAll(new RegExp(`(?<![\\d.])${form.replace('.', '\\.')}`, 'g'))]);
  return hits.length > 0 && hits.every((hit) => /[*x×]\s*$/i.test(compact.slice(0, hit.index)));
}

function trailingAmountMinor(line) {
  const match = String(line || '').replace(/,/g, '').match(/(?:^|[\p{L}\s(])(\d+(?:\.\d+)?)$/u);
  return match ? parseAmountMinor(match[1]) : null;
}

const NON_TRANSACTION_LINE = /\b(?:totals?|sub\s?total|balance|baki|remaining|opening|closing|dena\s+hai|lena\s+hai|s\.?\s?no|particulars?)\b/i;

function looksLikeTransactionLine(line) {
  return /\p{L}{2}/u.test(line) && !NON_TRANSACTION_LINE.test(line) && amountCandidatesMinor(line).size > 0;
}

function documentEntry(item, { source, lines, side, usedLines, fallbackDate, label, requirePrintedLine }) {
  if (!item || typeof item !== 'object') return null;
  let amountMinor = parseAmountMinor(item?.amount ?? item?.value);
  if (amountMinor == null || amountMinor === 0) return null;
  const major = String(Math.abs(amountMinor) / 100);
  if (/^[6-9]\d{9}$/.test(major) || !amountAppearsInDocument(amountMinor, source)) return null;
  const description = String(item.description || item.particulars || '').trim();
  const payee = String(item.payee || '').trim();
  const reference = String(item.reference || '').trim();
  if (!description && !payee) return null;
  // When the row's own printed line is found, its amount must be on it and its date wins.
  let printed = documentLine(lines, usedLines, description || payee, amountMinor);
  if (printed && !printed.hasAmount) return null;
  if (!printed) {
    const index = lines.findIndex((line, i) => !usedLines.has(i)
      && amountForms(amountMinor).some((form) => new RegExp(`(?<![\\d.])${form.replace('.', '\\.')}(?![\\d.])`).test(line.replace(/,/g, ''))));
    if (index >= 0) printed = { index, line: lines[index], hasAmount: true };
    else if (requirePrintedLine) return null;
  }
  if (printed) usedLines.add(printed.index);
  if (printed && rateOperandOnly(printed.line, amountMinor)) {
    amountMinor = trailingAmountMinor(withoutSideColumns([printed.line], side)[0]) ?? amountMinor;
  }
  const lineDate = printed ? lines.slice(0, printed.index + 1).reverse().find((line) => LINE_DATE.test(line))?.match(LINE_DATE)[1] : null;
  const entry = {
    source: 'sheet',
    worksheetName: basename(label),
    sourceHeaders: AI_HEADERS,
    date: isoDate(lineDate || item.date, isoDate(item.date, fallbackDate)),
    currency: normalizeCurrency(item.currency),
    description: description || payee,
    payee,
    category: String(item.category || '').trim(),
    reference,
    amountMinor: Math.abs(amountMinor),
    direction: directionFromLine(printed?.line || lineWithAmount(lines, amountMinor), amountMinor),
  };
  entry.rawJson = JSON.stringify([entry.date, description, payee, entry.amountMinor / 100, entry.direction, reference]);
  return entry;
}

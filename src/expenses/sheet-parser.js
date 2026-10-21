import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  documentExtension,
  extractDocumentText,
  extractSheetRowsWithModel,
  isSupportedSheetExtension,
} from './document-sheet-parser.js';
import {
  CANONICAL_EXPENSE_FIELDS,
  canonicalHeader,
  isoDate,
  normalizeCurrency,
  normalizeDirection,
  normalizeText,
  parseAmountMinor,
} from './expense-utils.js';
import { extractPdfText, parseExpensePdf, parsePhonePayPdfText } from './pdf-sheet-parser.js';

const STANDARD_HEADERS = ['Date', 'Direction', 'Amount', 'Currency', 'Payee', 'Category', 'Description', 'Reference', 'Source worksheet'];
const STANDARD_MAPPING = { date: 0, direction: 1, amount: 2, currency: 3, payee: 4, category: 5, description: 6, reference: 7, worksheetName: 8 };
const SUMMARY_SHEET_NAME = /^(?:summary|cover|readme|instructions|dashboard|pivot)(?:\b|\s|[-_])/i;
const TOTAL_LABELS = new Set(['total', 'subtotal', 'grand total', 'balance brought forward', 'balance carried forward']);

function cellValue(cell) {
  const value = cell?.value;
  if (value && typeof value === 'object') {
    if (value.result != null) return value.result;
    if (Array.isArray(value.richText)) return value.richText.map((x) => x.text || '').join('');
    if (value.text != null) return value.text;
  }
  return value ?? '';
}

function rowValues(row) {
  const out = [];
  for (let column = 1; column <= row.cellCount; column += 1) out.push(cellValue(row.getCell(column)));
  return out;
}

function candidateHeaderRows(worksheet) {
  const candidates = [];
  for (let number = 1; number <= Math.min(worksheet.rowCount, 30); number += 1) {
    const values = rowValues(worksheet.getRow(number));
    const nonEmpty = values.filter((value) => String(value ?? '').trim()).length;
    if (nonEmpty < 2) continue;
    const recognized = values.reduce((score, value) => score + (canonicalHeader(value) ? 1 : 0), 0);
    candidates.push({ number, values, nonEmpty, recognized });
  }
  candidates.sort((a, b) => b.recognized - a.recognized || b.nonEmpty - a.nonEmpty || a.number - b.number);
  return candidates;
}

async function inferHeaderMap(headers, inferHeaders) {
  if (typeof inferHeaders !== 'function') return {};
  let mapped;
  try { mapped = await inferHeaders(headers, CANONICAL_EXPENSE_FIELDS); } catch { return {}; }
  if (!mapped || typeof mapped !== 'object' || Array.isArray(mapped)) return {};
  const result = {};
  for (const [rawHeader, field] of Object.entries(mapped)) {
    if (CANONICAL_EXPENSE_FIELDS.includes(field)) result[String(rawHeader)] = field;
  }
  return result;
}

export async function mapHeaders(headers, inferHeaders) {
  const mapping = {};
  const unknown = [];
  headers.forEach((header, index) => {
    const field = canonicalHeader(header);
    if (field && mapping[field] == null) mapping[field] = index;
    else if (String(header ?? '').trim()) unknown.push(String(header));
  });

  const needsAmount = mapping.amount == null && mapping.debitAmount == null && mapping.creditAmount == null;
  const needsIdentity = mapping.description == null && mapping.payee == null
    && mapping.reference == null && mapping.category == null;
  if ((needsAmount || needsIdentity) && unknown.length) {
    const inferred = await inferHeaderMap(headers.map(String), inferHeaders);
    headers.forEach((header, index) => {
      const field = inferred[String(header)];
      if (field && mapping[field] == null) mapping[field] = index;
    });
  }
  return mapping;
}

function isEmptyAmount(value) {
  const amount = parseAmountMinor(value);
  return amount == null || amount === 0;
}

function rowIsSummary(values, mapping) {
  const labels = [mapping.description, mapping.payee, mapping.category]
    .filter((index) => index != null)
    .map((index) => normalizeText(values[index]));
  return labels.some((label) => TOTAL_LABELS.has(label));
}

function toExpenseRows(values, mapping, rowNumber, fallbackDate, headers, worksheetName) {
  if (rowIsSummary(values, mapping)) return [];
  const get = (field) => (mapping[field] == null ? '' : values[mapping[field]]);
  const description = String(get('description') ?? '').trim();
  const payee = String(get('payee') ?? '').trim();
  const reference = String(get('reference') ?? '').trim();
  const category = String(get('category') ?? '').trim();
  if (!description && !payee && !reference && !category && !get('date')) return [];
  const amountCurrency = get('amount') || get('debitAmount') || get('creditAmount');

  const common = {
    source: 'sheet',
    sheetRow: rowNumber,
    worksheetName,
    sourceHeaders: headers,
    date: isoDate(get('date'), fallbackDate),
    currency: normalizeCurrency(get('currency') || amountCurrency),
    description,
    payee,
    category,
    reference,
    rawJson: JSON.stringify(values),
  };
  const directionValue = get('direction');
  const amountIndex = mapping.amount;
  if (amountIndex != null && !isEmptyAmount(values[amountIndex])) {
    const amountMinor = parseAmountMinor(values[amountIndex]);
    const directionHeader = headers[amountIndex];
    return [{
      ...common,
      amountMinor: Math.abs(amountMinor),
      direction: normalizeDirection(directionValue || values[amountIndex], amountMinor, directionHeader),
    }];
  }

  const split = [];
  for (const [field, direction] of [['debitAmount', 'debit'], ['creditAmount', 'credit']]) {
    const value = get(field);
    if (isEmptyAmount(value)) continue;
    const amountMinor = parseAmountMinor(value);
    split.push({ ...common, amountMinor: Math.abs(amountMinor), direction });
  }
  if (split.length) return split;
  return [];
}

async function parseWorksheet(worksheet, { fallbackDate, inferHeaders }) {
  const candidates = candidateHeaderRows(worksheet);
  for (const headerRow of candidates) {
    const headers = headerRow.values.map((value) => String(value ?? '').trim());
    const mapping = await mapHeaders(headers, inferHeaders);
    if (mapping.amount == null && mapping.debitAmount == null && mapping.creditAmount == null) continue;
    if (mapping.description == null && mapping.payee == null && mapping.reference == null
      && mapping.category == null && mapping.date == null) continue;
    const entries = [];
    for (let rowNumber = headerRow.number + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      entries.push(...toExpenseRows(
        rowValues(worksheet.getRow(rowNumber)), mapping, rowNumber, fallbackDate, headers, worksheet.name,
      ));
    }
    if (entries.length) return { worksheetName: worksheet.name, headerRow: headerRow.number, headers, mapping, entries };
  }
  return null;
}

function sheetExtension(fileName, filePath) {
  const named = String(fileName || '').match(/\.(xlsx|csv|pdf)\b/i);
  if (named) return `.${named[1].toLowerCase()}`;
  return extname(String(filePath || '')).toLowerCase();
}

/**
 * Read an expense sheet from any supported file: spreadsheets by column mapping, Phone-pay
 * printouts deterministically when every dated line parses, everything else (other PDF layouts,
 * Word, text, photos, spreadsheets without recognisable columns) through the AI model.
 */
export async function parseExpenseSheet(filePath, {
  fallbackDate = null,
  inferHeaders = null,
  fileName = null,
  provider = null,
} = {}) {
  const ext = documentExtension(fileName, filePath);
  const label = basename(String(fileName || filePath || 'expense file'));
  if (ext === '.xlsx' || ext === '.csv') {
    try {
      return await parseExpenseWorkbook(filePath, { fallbackDate, inferHeaders, fileName });
    } catch (error) {
      if (!provider?.chat) throw error;
    }
  }
  if (!isSupportedSheetExtension(ext)) {
    throw new Error(`Unsupported expense file type ${ext || '(unknown)'}; send .xlsx, .csv, .pdf, .docx, .txt, or a photo of the sheet`);
  }
  let text;
  if (ext === '.pdf') {
    text = await extractPdfText(readFileSync(filePath));
    const fast = parsePhonePayPdfText(text, { fallbackDate });
    if (fast.complete) return fast.sheet;
  } else {
    text = await extractDocumentText(filePath, { ext, provider });
  }
  return extractSheetRowsWithModel(provider, text, { fallbackDate, label });
}

export async function parseExpenseWorkbook(filePath, {
  fallbackDate = null,
  inferHeaders = null,
  fileName = null,
} = {}) {
  const ext = sheetExtension(fileName, filePath);
  if (ext === '.pdf') {
    return parseExpensePdf(filePath, { fallbackDate, fileName });
  }
  const workbook = new ExcelJS.Workbook();
  if (ext === '.csv') await workbook.csv.readFile(filePath);
  else if (ext === '.xlsx') await workbook.xlsx.readFile(filePath);
  else throw new Error('Only .xlsx, .csv, and Phone-pay .pdf expense sheets are supported');

  const parsedWorksheets = [];
  for (const worksheet of workbook.worksheets) {
    const parsed = await parseWorksheet(worksheet, { fallbackDate, inferHeaders });
    if (parsed) parsedWorksheets.push(parsed);
  }
  if (!parsedWorksheets.length) {
    throw new Error('Could not identify expense columns and valid expense rows in the workbook');
  }
  // Summary/cover tabs often contain totals that would double-count transaction tabs.
  const transactionSheets = parsedWorksheets.filter((sheet) => !SUMMARY_SHEET_NAME.test(sheet.worksheetName));
  const selectedSheets = transactionSheets.length ? transactionSheets : parsedWorksheets;
  const entries = selectedSheets.flatMap((sheet) => sheet.entries);
  if (!entries.length) throw new Error('The expense sheet contains no valid expense rows');

  const multipleSheets = selectedSheets.length > 1;
  const primary = selectedSheets[0];
  return {
    worksheetName: multipleSheets ? selectedSheets.map((sheet) => sheet.worksheetName).join(', ') : primary.worksheetName,
    worksheetNames: selectedSheets.map((sheet) => sheet.worksheetName),
    headerRow: primary.headerRow,
    headers: multipleSheets ? STANDARD_HEADERS : primary.headers,
    mapping: multipleSheets ? STANDARD_MAPPING : primary.mapping,
    entries,
  };
}

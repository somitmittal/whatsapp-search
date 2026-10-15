import ExcelJS from 'exceljs';
import { extname } from 'node:path';
import {
  CANONICAL_EXPENSE_FIELDS,
  canonicalHeader,
  isoDate,
  normalizeCurrency,
  normalizeDirection,
  parseAmountMinor,
} from './expense-utils.js';

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
  for (let column = 1; column <= row.cellCount; column += 1) {
    out.push(cellValue(row.getCell(column)));
  }
  return out;
}

function firstHeaderRow(worksheet) {
  for (let n = 1; n <= Math.min(worksheet.rowCount, 20); n += 1) {
    const values = rowValues(worksheet.getRow(n));
    if (values.filter((v) => String(v ?? '').trim()).length >= 2) return { number: n, values };
  }
  return null;
}

async function inferHeaderMap(headers, inferHeaders) {
  if (typeof inferHeaders !== 'function') return {};
  const mapped = await inferHeaders(headers, CANONICAL_EXPENSE_FIELDS);
  if (!mapped || typeof mapped !== 'object') return {};
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
  if (mapping.amount != null || !unknown.length) return mapping;

  const inferred = await inferHeaderMap(headers.map(String), inferHeaders);
  headers.forEach((header, index) => {
    const field = inferred[String(header)];
    if (field && mapping[field] == null) mapping[field] = index;
  });
  return mapping;
}

function toExpense(values, mapping, rowNumber, fallbackDate, headers) {
  const get = (field) => (mapping[field] == null ? '' : values[mapping[field]]);
  const amountMinor = parseAmountMinor(get('amount'));
  if (amountMinor == null) return null;
  const description = String(get('description') ?? '').trim();
  const payee = String(get('payee') ?? '').trim();
  const reference = String(get('reference') ?? '').trim();
  if (!description && !payee && !reference) return null;
  const amountHeader = mapping.amount == null ? '' : headers[mapping.amount];
  return {
    source: 'sheet',
    sheetRow: rowNumber,
    date: isoDate(get('date'), fallbackDate),
    amountMinor: Math.abs(amountMinor),
    currency: normalizeCurrency(get('currency')),
    direction: normalizeDirection(get('direction'), amountMinor, amountHeader),
    description,
    payee,
    category: String(get('category') ?? '').trim(),
    reference,
    rawJson: JSON.stringify(values),
  };
}

export async function parseExpenseWorkbook(filePath, {
  fallbackDate = null,
  inferHeaders = null,
  fileName = null,
} = {}) {
  const workbook = new ExcelJS.Workbook();
  const ext = extname(String(fileName || filePath || '')).toLowerCase();
  if (ext === '.csv') await workbook.csv.readFile(filePath);
  else if (ext === '.xlsx') await workbook.xlsx.readFile(filePath);
  else throw new Error('Only .xlsx and .csv expense sheets are supported');

  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error('The expense sheet has no worksheet');
  const headerRow = firstHeaderRow(worksheet);
  if (!headerRow) throw new Error('Could not find a header row in the expense sheet');
  const headers = headerRow.values.map((v) => String(v ?? '').trim());
  const mapping = await mapHeaders(headers, inferHeaders);
  if (mapping.amount == null) throw new Error('Could not identify the amount column');
  if (mapping.description == null && mapping.payee == null && mapping.reference == null) {
    throw new Error('Could not identify a description, payee, or reference column');
  }

  const entries = [];
  for (let rowNumber = headerRow.number + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const values = rowValues(worksheet.getRow(rowNumber));
    const entry = toExpense(values, mapping, rowNumber, fallbackDate, headers);
    if (entry) entries.push(entry);
  }
  if (!entries.length) throw new Error('The expense sheet contains no valid expense rows');
  return {
    worksheetName: worksheet.name,
    headerRow: headerRow.number,
    headers,
    mapping,
    entries,
  };
}


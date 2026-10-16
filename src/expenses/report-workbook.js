import ExcelJS from 'exceljs';

/** Excel ARGB fills for reconciled sheet rows. */
export const EXPENSE_ROW_FILLS = {
  match: 'FFC6EFCE', // green — sheet row matches chat
  only_sheet: 'FFFFC7CE', // red — on sheet, not in chat
  missing_sheet: 'FFFFFF99', // yellow — in chat, missing on sheet (appended row)
  mismatch: 'FFFFC000', // amber — amounts / terms differ
  warn: 'FFF4F4F4',
};

function money(minor) {
  return Number(minor || 0) / 100;
}

function paintRow(row, fillArgb) {
  if (!fillArgb) return;
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: fillArgb },
    };
  });
}

function defaultHeaders() {
  return ['Date', 'Direction', 'Amount', 'Currency', 'Payee', 'Category', 'Description', 'Reference'];
}

/**
 * Map a canonical expense entry onto the original sheet column order.
 * @param {string[]} headers
 * @param {Record<string, number|null|undefined>} mapping
 * @param {object|null} entry
 */
export function entryValuesForHeaders(headers, mapping, entry) {
  const byField = {
    date: entry?.date || '',
    direction: entry?.direction || '',
    amount: entry == null ? '' : money(entry.amountMinor),
    currency: entry?.currency || '',
    payee: entry?.payee || '',
    category: entry?.category || '',
    description: entry?.description || '',
    reference: entry?.reference || '',
  };
  const fieldByIndex = new Map();
  for (const [field, index] of Object.entries(mapping || {})) {
    if (index == null || index < 0) continue;
    fieldByIndex.set(Number(index), field);
  }
  return headers.map((header, index) => {
    const field = fieldByIndex.get(index);
    if (field && Object.prototype.hasOwnProperty.call(byField, field)) return byField[field];
    // Fallback when headers are our canonical defaults
    const key = String(header || '').toLowerCase().replace(/\s+/g, '');
    if (key === 'date') return byField.date;
    if (key === 'direction') return byField.direction;
    if (key === 'amount') return byField.amount;
    if (key === 'currency') return byField.currency;
    if (key === 'payee' || key === 'paidto') return byField.payee;
    if (key === 'category') return byField.category;
    if (key === 'description') return byField.description;
    if (key === 'reference') return byField.reference;
    return '';
  });
}

/**
 * Build ordered display/report rows from a reconciliation result.
 * Sheet rows first (match / red / amber), then yellow chat-only rows.
 */
export function buildReconciledSheetRows(reconciliation = {}) {
  const matches = reconciliation.matches || [];
  const discrepancies = reconciliation.discrepancies || [];
  const rows = [];

  const sheetHandled = new Set();

  for (const m of matches) {
    const sheetEntry = m.sheetEntry;
    if (!sheetEntry) continue;
    sheetHandled.add(sheetEntry);
    rows.push({
      tone: 'match',
      status: 'Matched',
      fill: EXPENSE_ROW_FILLS.match,
      sheetEntry,
      chatEntry: m.chatEntry || null,
      chatAmount: m.chatEntry ? money(m.chatEntry.amountMinor) : money(sheetEntry.amountMinor),
      sheetAmount: money(sheetEntry.amountMinor),
    });
  }

  for (const item of discrepancies) {
    const type = item.type;
    if (type === 'missing_from_sheet') continue; // appended after sheet rows
    if (type === 'only_in_sheet' && item.sheetEntry) {
      sheetHandled.add(item.sheetEntry);
      rows.push({
        tone: 'only_sheet',
        status: 'Extra on sheet (not in chat)',
        fill: EXPENSE_ROW_FILLS.only_sheet,
        sheetEntry: item.sheetEntry,
        chatEntry: null,
        chatAmount: '',
        sheetAmount: money(item.sheetEntry.amountMinor),
      });
      continue;
    }
    if ((type === 'amount_mismatch' || type === 'needs_review') && item.sheetEntry) {
      sheetHandled.add(item.sheetEntry);
      rows.push({
        tone: 'mismatch',
        status: type === 'amount_mismatch' ? 'Amount differs' : (item.detail || 'Needs review'),
        fill: EXPENSE_ROW_FILLS.mismatch,
        sheetEntry: item.sheetEntry,
        chatEntry: item.chatEntry || null,
        chatAmount: item.chatEntry ? money(item.chatEntry.amountMinor) : '',
        sheetAmount: money(item.sheetEntry.amountMinor),
      });
      continue;
    }
    if (type === 'duplicate' && item.sheetEntry) {
      sheetHandled.add(item.sheetEntry);
      rows.push({
        tone: 'warn',
        status: item.detail || 'Duplicate on sheet',
        fill: EXPENSE_ROW_FILLS.warn,
        sheetEntry: item.sheetEntry,
        chatEntry: item.chatEntry || null,
        chatAmount: item.chatEntry ? money(item.chatEntry.amountMinor) : '',
        sheetAmount: money(item.sheetEntry.amountMinor),
      });
    }
  }

  for (const item of discrepancies) {
    if (item.type !== 'missing_from_sheet' || !item.chatEntry) continue;
    rows.push({
      tone: 'missing_sheet',
      status: 'Missing in sheet',
      fill: EXPENSE_ROW_FILLS.missing_sheet,
      sheetEntry: null,
      chatEntry: item.chatEntry,
      chatAmount: money(item.chatEntry.amountMinor),
      sheetAmount: '',
    });
  }

  return rows;
}

export async function buildExpenseReportWorkbook({
  siteName,
  date,
  sourceFileName,
  chatEntries = [],
  sheetEntries = [],
  reconciliation,
  sheetHeaders = null,
  sheetMapping = null,
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Searchable';
  workbook.created = new Date();

  const totals = reconciliation?.totals || {};
  const matchedCount = reconciliation?.matches?.length ?? totals.matchedCount ?? 0;
  const discrepancies = reconciliation?.discrepancies || [];
  const onlySheet = discrepancies.filter((d) => d.type === 'only_in_sheet').length;
  const missingSheet = discrepancies.filter((d) => d.type === 'missing_from_sheet').length;
  const mismatch = discrepancies.filter((d) => d.type === 'amount_mismatch' || d.type === 'needs_review').length;

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 28 }, { width: 56 }];
  [
    ['Site', siteName || ''],
    ['Business date', date || ''],
    ['Submitted sheet', sourceFileName || ''],
    ['Matched (green)', matchedCount],
    ['Extra on sheet (red)', onlySheet],
    ['Missing in sheet (yellow)', missingSheet],
    ['Amount differs (amber)', mismatch],
    ['Chat expenses', chatEntries.length],
    ['Sheet rows', sheetEntries.length],
    ['Legend', 'Green = match · Red = sheet only · Yellow = chat only · Amber = amounts differ'],
  ].forEach((row) => summary.addRow(row));
  summary.getColumn(1).font = { bold: true };
  summary.getRow(1).font = { bold: true };

  const headers = (Array.isArray(sheetHeaders) && sheetHeaders.length)
    ? sheetHeaders.map((h) => String(h ?? '').trim() || 'Column')
    : defaultHeaders();
  const mapping = sheetMapping || {
    date: 0, direction: 1, amount: 2, currency: 3, payee: 4, category: 5, description: 6, reference: 7,
  };

  const sheet = workbook.addWorksheet('Reconciled Sheet');
  const headerValues = [...headers, 'Chat Amount', 'Status'];
  const headerRow = sheet.addRow(headerValues);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } };
  });
  headers.forEach((_, i) => {
    sheet.getColumn(i + 1).width = Math.min(28, Math.max(12, String(headers[i]).length + 4));
  });
  sheet.getColumn(headers.length + 1).width = 14;
  sheet.getColumn(headers.length + 2).width = 28;
  const amountCol = mapping.amount != null ? mapping.amount + 1 : null;
  if (amountCol) sheet.getColumn(amountCol).numFmt = '#,##0.00';
  sheet.getColumn(headers.length + 1).numFmt = '#,##0.00';

  const rows = buildReconciledSheetRows(reconciliation);
  for (const row of rows) {
    const source = row.sheetEntry || row.chatEntry;
    const values = entryValuesForHeaders(headers, mapping, source);
    // For yellow (chat-only) rows, amounts live under the sheet amount column too for readability
    if (!row.sheetEntry && row.chatEntry && mapping.amount != null) {
      values[mapping.amount] = money(row.chatEntry.amountMinor);
    }
    const excelRow = sheet.addRow([...values, row.chatAmount === '' ? '' : row.chatAmount, row.status]);
    paintRow(excelRow, row.fill);
  }

  return workbook;
}

export async function writeExpenseReport(filePath, input) {
  const workbook = await buildExpenseReportWorkbook(input);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

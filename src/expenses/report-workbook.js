import ExcelJS from 'exceljs';

function money(minor) {
  return Number(minor || 0) / 100;
}

function addEntryColumns(sheet) {
  sheet.columns = [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'Direction', key: 'direction', width: 12 },
    { header: 'Amount', key: 'amount', width: 14 },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: 'Payee', key: 'payee', width: 24 },
    { header: 'Category', key: 'category', width: 16 },
    { header: 'Description', key: 'description', width: 40 },
    { header: 'Reference', key: 'reference', width: 20 },
    { header: 'Evidence', key: 'evidence', width: 24 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn('amount').numFmt = '#,##0.00';
}

function entryRow(entry) {
  return {
    date: entry?.date || '',
    direction: entry?.direction || '',
    amount: money(entry?.amountMinor),
    currency: entry?.currency || '',
    payee: entry?.payee || '',
    category: entry?.category || '',
    description: entry?.description || '',
    reference: entry?.reference || '',
    evidence: entry?.sourceMessageId || (entry?.sheetRow ? `Sheet row ${entry.sheetRow}` : ''),
  };
}

export async function buildExpenseReportWorkbook({
  siteName,
  date,
  sourceFileName,
  chatEntries,
  sheetEntries,
  reconciliation,
}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Searchable';
  workbook.created = new Date();

  const summary = workbook.addWorksheet('Summary');
  summary.columns = [{ width: 28 }, { width: 50 }];
  [
    ['Site', siteName || ''],
    ['Business date', date || ''],
    ['Submitted sheet', sourceFileName || ''],
    ['Chat expenses', chatEntries.length],
    ['Submitted rows', sheetEntries.length],
    ['Matched rows', reconciliation.matches.length],
    ['Discrepancies', reconciliation.discrepancies.length],
    ['Chat debit total', money(reconciliation.totals.chatDebitMinor)],
    ['Sheet debit total', money(reconciliation.totals.sheetDebitMinor)],
    ['Chat credit total', money(reconciliation.totals.chatCreditMinor)],
    ['Sheet credit total', money(reconciliation.totals.sheetCreditMinor)],
  ].forEach((row) => summary.addRow(row));
  summary.getColumn(1).font = { bold: true };
  for (const rowNumber of [8, 9, 10, 11]) summary.getCell(rowNumber, 2).numFmt = '#,##0.00';

  const diff = workbook.addWorksheet('Discrepancies');
  diff.columns = [
    { header: 'Type', key: 'type', width: 22 },
    { header: 'Detail', key: 'detail', width: 45 },
    { header: 'Chat Amount', key: 'chatAmount', width: 16 },
    { header: 'Sheet Amount', key: 'sheetAmount', width: 16 },
    { header: 'Payee / Description', key: 'description', width: 38 },
    { header: 'Message Evidence', key: 'evidence', width: 24 },
    { header: 'Sheet Row', key: 'sheetRow', width: 12 },
  ];
  diff.getRow(1).font = { bold: true };
  diff.getColumn('chatAmount').numFmt = '#,##0.00';
  diff.getColumn('sheetAmount').numFmt = '#,##0.00';
  reconciliation.discrepancies.forEach((item) => {
    diff.addRow({
      type: item.type,
      detail: item.detail,
      chatAmount: item.chatEntry ? money(item.chatEntry.amountMinor) : '',
      sheetAmount: item.sheetEntry ? money(item.sheetEntry.amountMinor) : '',
      description: item.chatEntry?.payee || item.chatEntry?.description
        || item.sheetEntry?.payee || item.sheetEntry?.description || '',
      evidence: item.chatEntry?.sourceMessageId || '',
      sheetRow: item.sheetEntry?.sheetRow || '',
    });
  });

  const chat = workbook.addWorksheet('Chat Expenses');
  addEntryColumns(chat);
  chatEntries.forEach((entry) => chat.addRow(entryRow(entry)));

  const submitted = workbook.addWorksheet('Submitted Sheet');
  addEntryColumns(submitted);
  sheetEntries.forEach((entry) => submitted.addRow(entryRow(entry)));

  return workbook;
}

export async function writeExpenseReport(filePath, input) {
  const workbook = await buildExpenseReportWorkbook(input);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}


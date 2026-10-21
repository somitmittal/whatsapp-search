import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, test } from '@jest/globals';
import { parseExpenseWorkbook } from '../src/expenses/sheet-parser.js';
import { reconcileExpenses } from '../src/expenses/reconciler.js';
import { buildExpenseReportWorkbook, buildReconciledSheetRows } from '../src/expenses/report-workbook.js';
import { isoDate, normalizeCurrency, parseAmountMinor } from '../src/expenses/expense-utils.js';

const scratch = mkdtempSync(join(tmpdir(), 'expense-domain-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function writeFixture(name, headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Expenses');
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  const path = join(scratch, name);
  await workbook.xlsx.writeFile(path);
  return path;
}

describe('expense spreadsheet parsing', () => {
  test('normalizes header variants and money into minor units', async () => {
    const path = await writeFixture(
      'daily.xlsx',
      ['Txn Date', 'Paid To', 'Expense Type', 'Paid Amount', 'Remarks', 'Bill No'],
      [['15/10/2026', 'Ravi labour team', 'Labour', '₹1,250.50', 'Daily wages', 'B-9']],
    );
    const parsed = await parseExpenseWorkbook(path);
    expect(parsed.entries).toEqual([expect.objectContaining({
      date: '2026-10-15',
      payee: 'Ravi labour team',
      category: 'Labour',
      amountMinor: 125050,
      description: 'Daily wages',
      reference: 'B-9',
    })]);
  });

  test('uses header-only inference when aliases do not identify amount', async () => {
    const path = await writeFixture(
      'variant.xlsx',
      ['Work day', 'Beneficiary', 'Rupees'],
      [['2026-10-15', 'Diesel pump', 500]],
    );
    const inferHeaders = async (headers) => ({
      [headers[0]]: 'date',
      [headers[1]]: 'payee',
      [headers[2]]: 'amount',
    });
    const parsed = await parseExpenseWorkbook(path, { inferHeaders });
    expect(parsed.entries[0]).toEqual(expect.objectContaining({
      date: '2026-10-15',
      payee: 'Diesel pump',
      amountMinor: 50000,
    }));
  });

  test('infers unfamiliar identity columns even when the amount header is already known', async () => {
    const path = await writeFixture(
      'mixed-headers.xlsx',
      ['Transaction Date', 'Paid By/To', 'Amount', 'Cost Center'],
      [['2026-10-15', 'Orchid Cloud', 29.99, 'Software']],
    );
    const inferHeaders = async (headers) => ({ [headers[1]]: 'payee', [headers[3]]: 'category' });
    const parsed = await parseExpenseWorkbook(path, { inferHeaders });
    expect(parsed.entries[0]).toEqual(expect.objectContaining({
      date: '2026-10-15', payee: 'Orchid Cloud', category: 'Software', amountMinor: 2999,
    }));
  });

  test('reads transaction tabs, ignores a summary tab, and handles separate debit and credit columns', async () => {
    const workbook = new ExcelJS.Workbook();
    const summary = workbook.addWorksheet('Summary');
    summary.addRow(['Date', 'Description', 'Amount']);
    summary.addRow(['2026-10-15', 'Grand total', 150]);
    const first = workbook.addWorksheet('Transactions A');
    first.addRow(['Daily expense register']);
    first.addRow(['Date', 'Paid To', 'Expense Head', 'Debit Amount', 'Credit Amount', 'Reference']);
    first.addRow(['15/10/2026', 'Orchid Cloud', 'Software', '1.234,56', '', 'INV-1']);
    const second = workbook.addWorksheet('Transactions B');
    second.addRow(['Date', 'Description', 'Category', 'Debit', 'Credit']);
    second.addRow(['16/10/2026', 'Refund annual plan', 'Software', '', 100]);
    const path = join(scratch, 'multi-sheet.xlsx');
    await workbook.xlsx.writeFile(path);

    const parsed = await parseExpenseWorkbook(path);
    expect(parsed.worksheetNames).toEqual(['Transactions A', 'Transactions B']);
    expect(parsed.entries).toEqual([
      expect.objectContaining({ worksheetName: 'Transactions A', amountMinor: 123456, direction: 'debit' }),
      expect.objectContaining({ worksheetName: 'Transactions B', amountMinor: 10000, direction: 'credit' }),
    ]);
    expect(parsed.headers).toContain('Source worksheet');
  });

  test('parses CSV with quoted fields and preserves the original expense columns in its report', async () => {
    const path = join(scratch, 'monthly.csv');
    writeFileSync(path, 'Date,Paid To,Amount,Description,Cost Center\n15/10/2026,"Vendor, Inc.",1.5k,"Monthly license",Research\n');
    const parsed = await parseExpenseWorkbook(path);
    expect(parsed.entries[0]).toEqual(expect.objectContaining({
      payee: 'Vendor, Inc.', amountMinor: 150000, category: '', description: 'Monthly license',
    }));
    const reconciliation = reconcileExpenses([], parsed.entries);
    const report = await buildExpenseReportWorkbook({
      siteName: 'Site', date: '2026-10-15', sourceFileName: 'monthly.csv',
      chatEntries: [], sheetEntries: parsed.entries, reconciliation,
      sheetHeaders: parsed.headers, sheetMapping: parsed.mapping,
    });
    expect(report.getWorksheet('Reconciled Sheet').getRow(2).getCell(5).value).toBe('Research');
  });

  test('parses credits represented by parentheses', () => {
    expect(parseAmountMinor('(1,000.25)')).toBe(-100025);
  });

  test.each([
    ['₹1,23,456.78', 12345678],
    ['1.234,56 EUR', 123456],
    ['1.5k', 150000],
    ['2 lakh', 20000000],
    ['1 crore', 1000000000],
    ['not an amount', null],
  ])('parses localized/shorthand amount %s', (input, expected) => {
    expect(parseAmountMinor(input)).toBe(expected);
  });

  test('normalizes currency markers and rejects impossible spreadsheet dates', () => {
    expect(parseAmountMinor('($1,234.50)')).toBe(-123450);
    expect(normalizeCurrency('$1,234.50')).toBe('USD');
    expect(normalizeCurrency('CAD $')).toBe('CAD');
    expect(isoDate('2026-02-31', '2026-10-15')).toBe('2026-10-15');
    expect(isoDate('31/13/2026', '2026-10-15')).toBe('2026-10-15');
  });

  test('keeps spreadsheet dates on their local calendar day', () => {
    expect(isoDate(new Date(2026, 9, 15))).toBe('2026-10-15');
    expect(isoDate('15 October 2026')).toBe('2026-10-15');
    expect(isoDate('Oct 15, 2026')).toBe('2026-10-15');
  });
});

describe('expense reconciliation', () => {
  const base = {
    date: '2026-10-15',
    currency: 'INR',
    direction: 'debit',
    payee: 'ABC Fuel',
    category: 'fuel',
    description: 'Diesel',
    reference: 'F-1',
  };

  test('matches by reference and reports amount mismatch', () => {
    const chat = [{ ...base, source: 'chat', sourceMessageId: 'm1', amountMinor: 50000 }];
    const sheet = [{ ...base, source: 'sheet', sheetRow: 2, amountMinor: 55000 }];
    const result = reconcileExpenses(chat, sheet);
    expect(result.matches).toHaveLength(0);
    expect(result.discrepancies).toEqual([
      expect.objectContaining({ type: 'amount_mismatch', chatEntry: chat[0], sheetEntry: sheet[0] }),
    ]);
  });

  test('matches different payee wording when amount, date, direction, and detail agree', () => {
    const chat = [{ ...base, source: 'chat', sourceMessageId: 'm1', reference: '', amountMinor: 50000, payee: 'Alex', description: 'monthly software subscription', category: 'Software' }];
    const sheet = [{ ...base, source: 'sheet', sheetRow: 2, reference: '', amountMinor: 50000, payee: 'Cloud vendor', description: 'software subscription renewal', category: 'Subscriptions' }];
    const result = reconcileExpenses(chat, sheet);
    expect(result.matches).toEqual([{ chatEntry: chat[0], sheetEntry: sheet[0] }]);
    expect(result.discrepancies).toEqual([]);
  });

  test('does not guess between multiple semantically similar same-amount rows', () => {
    const chat = [{ ...base, source: 'chat', sourceMessageId: 'm1', reference: '', amountMinor: 50000, payee: 'Alex', description: 'software subscription', category: 'Software' }];
    const sheet = [
      { ...base, source: 'sheet', sheetRow: 2, reference: '', amountMinor: 50000, payee: 'Vendor A', description: 'software subscription', category: 'Software' },
      { ...base, source: 'sheet', sheetRow: 3, reference: '', amountMinor: 50000, payee: 'Vendor B', description: 'software renewal', category: 'Software' },
    ];
    const result = reconcileExpenses(chat, sheet);
    expect(result.discrepancies.map((item) => item.type)).toContain('needs_review');
    expect(result.discrepancies.some((item) => item.type === 'only_in_sheet')).toBe(false);
    expect(buildReconciledSheetRows(result).filter((row) => row.tone === 'mismatch')).toHaveLength(2);
  });

  test('marks a unique amount/date candidate for review when wording has no overlap', () => {
    const chat = [{ ...base, source: 'chat', sourceMessageId: 'm1', reference: '', amountMinor: 50000, payee: 'Local taxi', category: 'travel', description: 'ride to airport' }];
    const sheet = [{ ...base, source: 'sheet', sheetRow: 2, reference: '', amountMinor: 50000, payee: 'Hotel', category: 'lodging', description: 'breakfast' }];
    const result = reconcileExpenses(chat, sheet);
    expect(result.matches).toHaveLength(0);
    expect(result.discrepancies).toEqual([
      expect.objectContaining({ type: 'needs_review', sheetEntry: sheet[0] }),
    ]);
  });

  test('does not match same amount across different dates or currencies', () => {
    const chat = [{ ...base, source: 'chat', sourceMessageId: 'm1', reference: '', amountMinor: 50000 }];
    const sheet = [{ ...base, source: 'sheet', sheetRow: 2, reference: '', date: '2026-10-16', currency: 'USD', amountMinor: 50000 }];
    const result = reconcileExpenses(chat, sheet);
    expect(result.matches).toHaveLength(0);
    expect(result.discrepancies.map((item) => item.type)).toEqual(['missing_from_sheet', 'only_in_sheet']);
  });

  test('matches a bare-amount chat message to the unique same-day row of that amount', () => {
    const chat = [{ ...base, source: 'chat', sourceMessageId: 'm1', reference: '', amountMinor: 150000, payee: '', description: '', category: 'other' }];
    const sheet = [{ ...base, source: 'sheet', sheetRow: 2, reference: '', amountMinor: 150000, payee: '', description: 'Ramesh labour advance rewa', category: '' }];
    const result = reconcileExpenses(chat, sheet);
    expect(result.matches).toEqual([{ chatEntry: chat[0], sheetEntry: sheet[0] }]);
    expect(result.discrepancies).toEqual([]);
  });

  test('reviews one row when the same amount and date are read as paid on one side and received on the other', () => {
    const chat = [{ ...base, source: 'chat', sourceMessageId: 'm1', reference: '', amountMinor: 4000000, direction: 'debit', payee: '', description: '40000 diye' }];
    const sheet = [{ ...base, source: 'sheet', sheetRow: 4, reference: '', amountMinor: 4000000, direction: 'credit', payee: 'Santosh bhaiya', description: 'Santosh bhaiya' }];
    const result = reconcileExpenses(chat, sheet);
    expect(result.discrepancies).toEqual([
      expect.objectContaining({ type: 'needs_review', chatEntry: chat[0], sheetEntry: sheet[0] }),
    ]);
  });

  test('flags a shared reference with a different currency for review', () => {
    const chat = [{ ...base, source: 'chat', sourceMessageId: 'm1', amountMinor: 10000, currency: 'USD' }];
    const sheet = [{ ...base, source: 'sheet', sheetRow: 2, amountMinor: 10000, currency: 'INR' }];
    const result = reconcileExpenses(chat, sheet);
    expect(result.matches).toHaveLength(0);
    expect(result.discrepancies.map((item) => item.type)).toEqual(['needs_review']);
  });

  test('does not also mark ambiguous sheet rows as sheet-only', () => {
    const chat = [{ ...base, reference: '', source: 'chat', sourceMessageId: 'm1', amountMinor: 90000, payee: 'Mason crew' }];
    const sheet = [
      { ...base, reference: '', source: 'sheet', sheetRow: 2, amountMinor: 90000, payee: 'Mason crew' },
      { ...base, reference: '', source: 'sheet', sheetRow: 3, amountMinor: 90000, payee: 'Mason crew' },
    ];
    const result = reconcileExpenses(chat, sheet);
    expect(result.discrepancies.map((item) => item.type)).toEqual(['duplicate', 'needs_review']);
  });

  test('reports missing, sheet-only, duplicate, and ambiguous entries', () => {
    const chat = [
      { ...base, source: 'chat', sourceMessageId: 'm1', amountMinor: 50000 },
      { ...base, source: 'chat', sourceMessageId: 'm2', amountMinor: 50000 },
    ];
    const sheet = [
      { ...base, source: 'sheet', sheetRow: 2, amountMinor: 50000 },
      { ...base, source: 'sheet', sheetRow: 3, amountMinor: 50000 },
      { ...base, reference: 'other', payee: 'Other', source: 'sheet', sheetRow: 4, amountMinor: 10000 },
    ];
    const result = reconcileExpenses(chat, sheet);
    expect(result.discrepancies.map((item) => item.type)).toEqual(expect.arrayContaining([
      'duplicate', 'needs_review', 'only_in_sheet',
    ]));
  });
});

describe('expense report workbook', () => {
  test('outputs a small summary plus a colored copy of the sheet', async () => {
    const chatMatch = {
      source: 'chat', sourceMessageId: 'm1', date: '2026-10-15', amountMinor: 50000,
      currency: 'INR', direction: 'debit', payee: 'HP Pump', category: 'fuel', description: 'Diesel',
      sourceText: 'Paid ₹500 to HP Pump for diesel', sourceSender: 'Site manager',
    };
    const sheetMatch = {
      source: 'sheet', sheetRow: 2, date: '2026-10-15', amountMinor: 50000,
      currency: 'INR', direction: 'debit', payee: 'Fuel pump', category: 'fuel', description: 'Diesel for site',
    };
    const sheetOnly = {
      source: 'sheet', sheetRow: 3, date: '2026-10-15', amountMinor: 20000,
      currency: 'INR', direction: 'debit', payee: 'Extra', category: 'material', description: 'Cement',
    };
    const chatOnly = {
      source: 'chat', sourceMessageId: 'm2', date: '2026-10-15', amountMinor: 15000,
      currency: 'INR', direction: 'debit', payee: 'Ravi', category: 'labour', description: 'Wages',
    };
    const reconciliation = {
      matches: [{ chatEntry: chatMatch, sheetEntry: sheetMatch }],
      discrepancies: [
        { type: 'only_in_sheet', chatEntry: null, sheetEntry: sheetOnly, detail: 'Sheet only' },
        { type: 'missing_from_sheet', chatEntry: chatOnly, sheetEntry: null, detail: 'Missing' },
      ],
      totals: { chatDebitMinor: 65000, sheetDebitMinor: 70000, chatCreditMinor: 0, sheetCreditMinor: 0 },
    };
    const workbook = await buildExpenseReportWorkbook({
      siteName: 'Site A',
      date: '2026-10-15',
      sourceFileName: 'expenses.xlsx',
      chatEntries: [chatMatch, chatOnly],
      sheetEntries: [sheetMatch, sheetOnly],
      reconciliation,
      sheetHeaders: ['Date', 'Paid To', 'Amount', 'Description'],
      sheetMapping: { date: 0, payee: 1, amount: 2, description: 3 },
    });
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Summary', 'Reconciled Sheet',
    ]);
    const sheet = workbook.getWorksheet('Reconciled Sheet');
    // header + match + red + yellow
    expect(sheet.rowCount).toBe(4);
    expect(sheet.getRow(2).getCell(1).fill?.fgColor?.argb).toBe('FFC6EFCE');
    expect(sheet.getRow(3).getCell(1).fill?.fgColor?.argb).toBe('FFFFC7CE');
    expect(sheet.getRow(4).getCell(1).fill?.fgColor?.argb).toBe('FFFFFF99');
    expect(sheet.getRow(2).getCell(6).value).toBe('m1');
    expect(sheet.getRow(2).getCell(7).value).toBe('Paid ₹500 to HP Pump for diesel');
    expect(sheet.getRow(2).getCell(9).value).toBe(2);
  });
});


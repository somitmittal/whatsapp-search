import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, test } from '@jest/globals';
import { parseExpenseWorkbook } from '../src/expenses/sheet-parser.js';
import { reconcileExpenses } from '../src/expenses/reconciler.js';
import { buildExpenseReportWorkbook } from '../src/expenses/report-workbook.js';
import { isoDate, parseAmountMinor } from '../src/expenses/expense-utils.js';

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

  test('parses credits represented by parentheses', () => {
    expect(parseAmountMinor('(1,000.25)')).toBe(-100025);
  });

  test('keeps spreadsheet dates on their local calendar day', () => {
    expect(isoDate(new Date(2026, 9, 15))).toBe('2026-10-15');
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
  test('contains summary, diff, and source sheets', async () => {
    const chatEntry = {
      source: 'chat', sourceMessageId: 'm1', date: '2026-10-15', amountMinor: 10000,
      currency: 'INR', direction: 'debit', payee: 'Worker', category: 'labour', description: 'Wages',
    };
    const reconciliation = {
      matches: [],
      discrepancies: [{ type: 'missing_from_sheet', chatEntry, sheetEntry: null, detail: 'Missing' }],
      totals: { chatDebitMinor: 10000, sheetDebitMinor: 0, chatCreditMinor: 0, sheetCreditMinor: 0 },
    };
    const workbook = await buildExpenseReportWorkbook({
      siteName: 'Site A',
      date: '2026-10-15',
      sourceFileName: 'expenses.xlsx',
      chatEntries: [chatEntry],
      sheetEntries: [],
      reconciliation,
    });
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Summary', 'Discrepancies', 'Chat Expenses', 'Submitted Sheet',
    ]);
    expect(workbook.getWorksheet('Discrepancies').rowCount).toBe(2);
  });
});


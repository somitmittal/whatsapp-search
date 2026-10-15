import { writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, test } from '@jest/globals';
import ExpenseReconciliationService, {
  isExpenseSheetMessage,
} from '../src/expenses/expense-reconciliation-service.js';

const scratch = mkdtempSync(join(tmpdir(), 'expense-service-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function expenseSheet(name = 'expenses.xlsx') {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Expenses');
  sheet.addRow(['Date', 'Paid To', 'Amount', 'Description']);
  sheet.addRow(['2026-10-15', 'Fuel pump', 500, 'Diesel']);
  const path = join(scratch, name);
  await workbook.xlsx.writeFile(path);
  return path;
}

function fakeDb(mediaPath) {
  const state = {
    run: null,
    updates: [],
    saved: null,
  };
  return {
    state,
    getSetting: (key) => ({ smb_profile: 'construction', construction_expense_agent: '1' })[key] || '',
    getMessageRowByMessageId: () => ({
      messageId: 'sheet-1',
      chatJid: 'site-a@g.us',
      chatName: 'Site A',
      sender: 'Accountant',
      text: 'expenses.xlsx',
      timestamp: 1792013400,
    }),
    getMessageMediaRecord: () => ({ mediaPath, mediaType: 'document' }),
    createExpenseReconciliationRun(input) {
      if (!state.run) state.run = { id: 7, status: 'queued', ...input };
      return { ...state.run };
    },
    updateExpenseReconciliationRun(_id, patch) {
      state.updates.push(patch);
      state.run = { ...state.run, ...patch };
    },
    getMessagesByTimeRange: () => [{
      messageId: 'm-expense',
      sender: 'Supervisor',
      text: 'Paid ₹500 to Fuel pump for diesel',
    }],
    replaceExpenseReconciliationData(_id, entries, discrepancies) {
      state.saved = { entries, discrepancies };
    },
    getExpenseReconciliationRun: () => ({
      ...state.run,
      entries: state.saved?.entries || [],
      discrepancies: state.saved?.discrepancies || [],
    }),
    listRecoverableExpenseRuns: () => [],
    resetExpenseReconciliationRun: () => true,
  };
}

describe('expense reconciliation automation', () => {
  test('only accepts incoming CSV/XLSX documents in live groups', () => {
    const row = { chatJid: 'site@g.us', sender: 'Staff', text: 'daily.xlsx' };
    expect(isExpenseSheetMessage(row, '/tmp/daily.xlsx')).toBe(true);
    expect(isExpenseSheetMessage({ ...row, sender: 'You' }, '/tmp/daily.xlsx')).toBe(false);
    expect(isExpenseSheetMessage({ ...row, chatJid: 'import_site@imported' }, '/tmp/daily.xlsx')).toBe(false);
    expect(isExpenseSheetMessage(row, '/tmp/searchable-expense-report-7.xlsx')).toBe(false);
    expect(isExpenseSheetMessage({ ...row, text: 'receipt.pdf' }, '/tmp/receipt.pdf')).toBe(false);
  });

  test('reconciles once and sends the generated report to the same group', async () => {
    const path = await expenseSheet();
    const db = fakeDb(path);
    const provider = {
      chat: async () => JSON.stringify([{
        source_message_id: 'm-expense',
        amount: '500',
        currency: 'INR',
        direction: 'debit',
        date: '2026-10-15',
        payee: 'Fuel pump',
        category: 'fuel',
        description: 'Diesel',
      }]),
    };
    const sends = [];
    const service = new ExpenseReconciliationService({
      db,
      getProvider: () => provider,
      getWaClient: () => ({
        sendDocument: async (chatJid, reportPath, options) => {
          sends.push({ chatJid, reportPath, options });
          return { key: { id: 'report-message' } };
        },
      }),
    });
    await service.enqueueMessage('sheet-1', 'tenant-a');
    expect(sends).toHaveLength(1);
    expect(sends[0].chatJid).toBe('site-a@g.us');
    expect(sends[0].options.caption).toMatch(/No discrepancies found/);
    expect(db.state.run.status).toBe('completed');
    expect(db.state.saved.discrepancies).toHaveLength(0);

    await service.enqueueMessage('sheet-1', 'tenant-a');
    expect(sends).toHaveLength(1);
  });

  test('records parse failures without sending a WhatsApp report', async () => {
    const path = join(scratch, 'broken.xlsx');
    writeFileSync(path, 'not an xlsx file');
    const db = fakeDb(path);
    let sendCount = 0;
    const service = new ExpenseReconciliationService({
      db,
      getProvider: () => ({ chat: async () => '[]' }),
      getWaClient: () => ({ sendDocument: async () => { sendCount += 1; } }),
    });
    await service.enqueueMessage('sheet-1', 'tenant-b');
    expect(sendCount).toBe(0);
    expect(db.state.run.status).toBe('failed');
    expect(db.state.run.error).toBeTruthy();
  });

  test('does not process spreadsheets unless the Construction profile is active', async () => {
    const path = await expenseSheet('personal.xlsx');
    const db = fakeDb(path);
    db.getSetting = () => 'personal';
    const service = new ExpenseReconciliationService({
      db,
      getProvider: () => ({ chat: async () => '[]' }),
      getWaClient: () => ({ sendDocument: async () => { throw new Error('should not send'); } }),
    });
    await expect(service.enqueueMessage('sheet-1', 'tenant-c')).resolves.toBeNull();
    expect(db.state.run).toBeNull();
  });

  test('does not process spreadsheets on Construction until the agent is enabled', async () => {
    const path = await expenseSheet('agent-off.xlsx');
    const db = fakeDb(path);
    db.getSetting = (key) => (key === 'smb_profile' ? 'construction' : '0');
    const service = new ExpenseReconciliationService({
      db,
      getProvider: () => ({ chat: async () => '[]' }),
      getWaClient: () => ({ sendDocument: async () => { throw new Error('should not send'); } }),
    });
    await expect(service.enqueueMessage('sheet-1', 'tenant-d')).resolves.toBeNull();
    expect(db.state.run).toBeNull();
  });
});


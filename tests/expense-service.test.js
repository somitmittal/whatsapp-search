import { writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, describe, expect, test } from '@jest/globals';
import ExpenseReconciliationService, {
  isExpenseSheetMessage,
} from '../src/expenses/expense-reconciliation-service.js';
import { dayBoundsFromDate } from '../src/expenses/chat-expense-extractor.js';

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
    getSetting: (key) => ({
      smb_profile: 'construction',
      construction_expense_agent: '1',
      construction_expense_site_jids: JSON.stringify(['site-a@g.us']),
    })[key] || '',
    listExpenseSheetMessages: () => [],
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

  test('auto-run skips groups that are not selected as sites', async () => {
    const path = await expenseSheet('other-group.xlsx');
    const db = fakeDb(path);
    db.getSetting = (key) => ({
      smb_profile: 'construction',
      construction_expense_agent: '1',
      construction_expense_site_jids: JSON.stringify(['other-site@g.us']),
    })[key] || '';
    const service = new ExpenseReconciliationService({
      db,
      getProvider: () => ({ chat: async () => '[]' }),
      getWaClient: () => ({ sendDocument: async () => { throw new Error('should not send'); } }),
    });
    await expect(service.enqueueMessage('sheet-1', 'tenant-e')).resolves.toBeNull();
    expect(db.state.run).toBeNull();
  });

  test('manual runForChat bypasses the site allowlist', async () => {
    const path = await expenseSheet('manual.xlsx');
    const db = fakeDb(path);
    db.getSetting = (key) => ({
      smb_profile: 'construction',
      construction_expense_agent: '1',
      construction_expense_site_jids: JSON.stringify([]),
    })[key] || '';
    db.listExpenseSheetMessages = () => [{
      messageId: 'sheet-1',
      chatJid: 'site-a@g.us',
      sender: 'Accountant',
      text: 'manual.xlsx',
      mediaPath: path,
    }];
    const sends = [];
    const service = new ExpenseReconciliationService({
      db,
      getProvider: () => ({
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
      }),
      getWaClient: () => ({
        sendDocument: async (chatJid, reportPath, options) => {
          sends.push({ chatJid, reportPath, options });
          return { key: { id: 'report-message' } };
        },
      }),
    });
    await service.runForChat({ chatJid: 'site-a@g.us' }, 'tenant-f');
    expect(sends).toHaveLength(1);
    expect(sends[0].chatJid).toBe('site-a@g.us');
  });

  test('interactive run completes without sending WhatsApp when notifyWhatsApp is false', async () => {
    const path = await expenseSheet('interactive.xlsx');
    const db = fakeDb(path);
    db.listExpenseSheetMessages = () => [{
      messageId: 'sheet-1',
      chatJid: 'site-a@g.us',
      sender: 'Accountant',
      text: 'interactive.xlsx',
      mediaPath: path,
    }];
    let sendCount = 0;
    let selectedProviderCalls = 0;
    const selectedProvider = {
      chat: async () => {
        selectedProviderCalls += 1;
        return JSON.stringify([{
          source_message_id: 'm-expense', amount: '500', currency: 'INR', direction: 'debit',
          date: '2026-10-15', payee: 'Fuel pump', category: 'fuel', description: 'Diesel',
        }]);
      },
    };
    const service = new ExpenseReconciliationService({
      db,
      getProvider: () => { throw new Error('must use the selected conversation model'); },
      getWaClient: () => ({
        sendDocument: async () => {
          sendCount += 1;
          return { key: { id: 'should-not-send' } };
        },
      }),
    });
    const run = await service.runForChat(
      { chatJid: 'site-a@g.us', notifyWhatsApp: false, provider: selectedProvider },
      'tenant-g',
    );
    expect(sendCount).toBe(0);
    expect(selectedProviderCalls).toBeGreaterThan(0);
    expect(run.status).toBe('completed');
    expect(run.reportPath).toBeTruthy();
  });

  test('loads chat evidence for every date represented across the workbook', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Transactions');
    sheet.addRow(['Date', 'Paid To', 'Amount', 'Description']);
    sheet.addRow(['2026-10-15', 'Travel', 120, 'Taxi']);
    sheet.addRow(['2026-10-17', 'Cloud', 30, 'Software subscription']);
    const path = join(scratch, 'multi-day.xlsx');
    await workbook.xlsx.writeFile(path);

    const db = fakeDb(path);
    db.listExpenseSheetMessages = () => [{ messageId: 'sheet-1', chatJid: 'site-a@g.us', mediaPath: path }];
    const messages = [
      { messageId: 'm-taxi', sender: 'Staff', text: 'Paid 120 for taxi', timestamp: dayBoundsFromDate('2026-10-15').startTs + 12 * 3600 },
      { messageId: 'm-cloud', sender: 'Staff', text: 'Cloud software subscription 30', timestamp: dayBoundsFromDate('2026-10-17').startTs + 12 * 3600 },
    ];
    let range;
    db.getMessagesByTimeRange = (_jid, start, end) => {
      range = { start, end };
      return messages;
    };
    const provider = {
      chat: async () => JSON.stringify([
        { source_message_id: 'm-taxi', amount: 120, date: '2026-10-15', payee: 'Taxi', description: 'Travel', category: 'transport' },
        { source_message_id: 'm-cloud', amount: 30, date: '2026-10-17', payee: 'Cloud', description: 'Software subscription', category: 'software' },
      ]),
    };
    const service = new ExpenseReconciliationService({ db, getProvider: () => provider });
    await service.runForChat({ chatJid: 'site-a@g.us', notifyWhatsApp: false }, 'tenant-range');

    expect(range).toEqual({
      start: dayBoundsFromDate('2026-10-15').startTs,
      end: dayBoundsFromDate('2026-10-17').endTs,
    });
    expect(db.state.saved.discrepancies).toHaveLength(0);
    expect(db.state.run.businessDate).toBe('2026-10-15 – 2026-10-17');
  });
});


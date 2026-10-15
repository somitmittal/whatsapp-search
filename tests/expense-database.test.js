import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

const scratch = mkdtempSync(join(tmpdir(), 'expense-db-'));
process.env.DATA_DIR = scratch;

const { default: Database } = await import('../src/storage/database.js');
const { runWithTenant } = await import('../src/storage/tenant-context.js');

let db;
beforeAll(() => {
  db = new Database();
});
afterAll(() => {
  try { db?.close?.(); } catch { /* */ }
  rmSync(scratch, { recursive: true, force: true });
});

describe('expense reconciliation persistence', () => {
  test('stores auditable entries and discrepancy links', () => {
    runWithTenant('tenant-expense-a', () => {
      const run = db.createExpenseReconciliationRun({
        chatJid: 'site@g.us',
        chatName: 'Site',
        sourceMessageId: 'sheet-1',
        sourceFileName: 'daily.xlsx',
        sourceMediaPath: '/tmp/daily.xlsx',
        businessDate: '2026-10-15',
      });
      const chat = {
        source: 'chat', sourceMessageId: 'm1', date: '2026-10-15', amountMinor: 10000,
        currency: 'INR', direction: 'debit', payee: 'Worker', category: 'labour',
      };
      const sheet = {
        source: 'sheet', sheetRow: 2, date: '2026-10-15', amountMinor: 9000,
        currency: 'INR', direction: 'debit', payee: 'Worker', category: 'labour',
      };
      db.replaceExpenseReconciliationData(run.id, [chat, sheet], [{
        type: 'amount_mismatch',
        chatEntry: chat,
        sheetEntry: sheet,
        detail: 'Different amount',
      }]);
      db.updateExpenseReconciliationRun(run.id, {
        status: 'completed',
        totals: { discrepancyCount: 1 },
      });

      const detail = db.getExpenseReconciliationRun(run.id);
      expect(detail.status).toBe('completed');
      expect(detail.entries).toHaveLength(2);
      expect(detail.discrepancies[0]).toEqual(expect.objectContaining({
        type: 'amount_mismatch',
        chatEntry: expect.objectContaining({ sourceMessageId: 'm1' }),
        sheetEntry: expect.objectContaining({ sheetRow: 2 }),
      }));
      expect(db.resolveExpenseDiscrepancy(detail.discrepancies[0].id, 'accepted')).toBe(true);
      expect(db.getExpenseReconciliationRun(run.id).discrepancies[0].resolution).toBe('accepted');
    });
  });

  test('isolates runs by tenant', () => {
    const a = runWithTenant('tenant-expense-a', () => db.listExpenseReconciliationRuns());
    const b = runWithTenant('tenant-expense-b', () => db.listExpenseReconciliationRuns());
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });
});


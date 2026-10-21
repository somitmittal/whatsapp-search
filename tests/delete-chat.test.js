import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

const scratch = mkdtempSync(join(tmpdir(), 'wa-delete-chat-'));
process.env.DATA_DIR = scratch;

const { default: Database } = await import('../src/storage/database.js');
const { LEGACY_TENANT_ID } = await import('../src/storage/tenant-constants.js');
const { runWithTenant } = await import('../src/storage/tenant-context.js');

let db;
beforeAll(() => { db = new Database(); });
afterAll(() => {
  try { db?.close?.(); } catch { /* */ }
  rmSync(scratch, { recursive: true, force: true });
});

describe('deleteChat for imported archives', () => {
  test('removes messages, import touch, and expense runs for the chat', async () => {
    await runWithTenant(LEGACY_TENANT_ID, async () => {
      const jid = 'import_delete_me@imported';
      db.insertMessageBatch([
        {
          messageId: 'imp_1',
          chatJid: jid,
          chatName: 'Delete Me',
          sender: 'A',
          text: 'hello',
          timestamp: 1_700_000_000,
        },
        {
          messageId: 'keep_1',
          chatJid: 'import_keep@imported',
          chatName: 'Keep',
          sender: 'B',
          text: 'stay',
          timestamp: 1_700_000_001,
        },
      ]);
      db.recordChatImportTouch(jid, 1_700_000_100);
      db.createExpenseReconciliationRun({
        chatJid: jid,
        chatName: 'Delete Me',
        sourceMessageId: 'imp_1',
        businessDate: '2026-01-01',
      });

      expect(db.deleteChat(jid)).toBe(1);

      const left = db._db.prepare(
        'SELECT chat_jid AS chatJid, COUNT(*) AS n FROM messages WHERE tenant_id = ? GROUP BY 1',
      ).all(LEGACY_TENANT_ID);
      expect(left).toEqual([{ chatJid: 'import_keep@imported', n: 1 }]);
      expect(db._db.prepare(
        'SELECT COUNT(*) AS c FROM chat_import_touches WHERE tenant_id = ? AND chat_jid = ?',
      ).get(LEGACY_TENANT_ID, jid).c).toBe(0);
      expect(db._db.prepare(
        'SELECT COUNT(*) AS c FROM expense_reconciliation_runs WHERE tenant_id = ? AND chat_jid = ?',
      ).get(LEGACY_TENANT_ID, jid).c).toBe(0);
    });
  });
});

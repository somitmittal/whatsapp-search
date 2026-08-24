import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';

const scratch = mkdtempSync(join(tmpdir(), 'wa-index-optin-'));
process.env.DATA_DIR = scratch;

const { default: Database } = await import('../src/storage/database.js');

let db;
beforeAll(() => { db = new Database(); });
afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

const NOW = Math.floor(Date.now() / 1000);
const OLD = NOW - (20 * 24 * 60 * 60);

function insertChat(chatJid, count, timestamp, extra = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      messageId: `${chatJid}-${i}`,
      chatJid,
      chatName: extra.chatName || chatJid,
      sender: 'Asha',
      text: extra.text || `message ${i} hello there`,
      timestamp,
      mediaType: extra.mediaType || null,
      mediaPath: extra.mediaPath || null,
    });
  }
  db.insertMessageBatch(rows);
}

describe('auto-index gate on pending jobs', () => {
  test('skips a recent chat that has not grown past 50 messages', () => {
    insertChat('small-recent@g.us', 10, NOW);
    const jobs = db.getPendingEmbeddingJobs(20, null, 'test-model');
    expect(jobs.some((j) => j.chatJid === 'small-recent@g.us')).toBe(false);
    const stats = db.getChatStats().find((c) => c.chatJid === 'small-recent@g.us');
    expect(stats.indexEligible).toBe(false);
    expect(stats.indexOptedIn).toBe(false);
  });

  test('indexes a recent chat once it has more than 50 messages', () => {
    insertChat('big-recent@g.us', 51, NOW);
    const jobs = db.getPendingEmbeddingJobs(80, null, 'test-model');
    expect(jobs.some((j) => j.chatJid === 'big-recent@g.us')).toBe(true);
    const stats = db.getChatStats().find((c) => c.chatJid === 'big-recent@g.us');
    expect(stats.indexEligible).toBe(true);
  });

  test('skips a large chat whose latest message is older than 10 days', () => {
    insertChat('big-old@g.us', 51, OLD);
    const jobs = db.getPendingEmbeddingJobs(80, null, 'test-model');
    expect(jobs.some((j) => j.chatJid === 'big-old@g.us')).toBe(false);
  });

  test('skips Status even when it is large and recent', () => {
    insertChat('status@broadcast', 51, NOW, { chatName: 'Status' });
    const jobs = db.getPendingEmbeddingJobs(80, null, 'test-model');
    expect(jobs.some((j) => j.chatJid === 'status@broadcast')).toBe(false);
  });

  test('an explicit opt-in indexes a small chat that the auto bar skipped', () => {
    insertChat('opted@s.whatsapp.net', 4, NOW, { chatName: 'Quiet' });
    expect(db.optInChatForIndex('opted@s.whatsapp.net')).toBe(true);
    const jobs = db.getPendingEmbeddingJobs(12, 'opted@s.whatsapp.net', 'test-model');
    expect(jobs.some((j) => j.chatJid === 'opted@s.whatsapp.net')).toBe(true);
    const stats = db.getChatStats().find((c) => c.chatJid === 'opted@s.whatsapp.net');
    expect(stats.indexOptedIn).toBe(true);
    expect(stats.indexEligible).toBe(true);
  });
});

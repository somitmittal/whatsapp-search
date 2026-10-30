import { describe, expect, test } from '@jest/globals';
import { createToolbox } from '../src/gpt/tools.js';

describe('reconcile tool', () => {
  test('forwards chat + date into the expense skill command', async () => {
    let ran = null;
    const toolbox = createToolbox({
      db: {},
      embeddings: null,
      directory: {
        resolve: (ref) => (String(ref).toLowerCase().includes('phon')
          ? { chatJid: 'phon@imported', chatName: 'Phonpay' }
          : null),
      },
      runSkill: async ({ text, mentions }) => {
        ran = { text, mentions };
        return {
          answer: 'ok',
          expenseDiff: { chatName: 'Phonpay', businessDate: '2026-10-10' },
          skillRun: { id: 'r1' },
          choices: [],
          steps: [],
        };
      },
    });

    const out = await toolbox.reconcile(
      { chat: 'Phonpay', date: '10th Oct' },
      0,
      { turnMentions: [], scopeChatName: 'Phonpay', scopeChatJid: 'phon@imported' },
    );
    expect(ran.text).toBe('/accountant/expense-reconciliation Phonpay 10th Oct');
    expect(out.payload.expenseDiff.businessDate).toBe('2026-10-10');
  });
});

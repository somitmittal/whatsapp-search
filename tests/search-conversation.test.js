import { describe, expect, test } from '@jest/globals';
import { isExpenseReconcileQuery } from '../src/search/search-conversation-service.js';

describe('isExpenseReconcileQuery', () => {
  test('detects natural-language expense compare prompts', () => {
    expect(isExpenseReconcileQuery(
      "check today's expense summary on chat and compare it with the excel sheet sent at the end of the day",
    )).toBe(true);
    expect(isExpenseReconcileQuery('Reconcile Site 2 expenses vs the xlsx')).toBe(true);
    expect(isExpenseReconcileQuery('show discrepancies in the expense sheet')).toBe(true);
  });

  test('ignores ordinary search queries', () => {
    expect(isExpenseReconcileQuery('what did Ravi say about cement')).toBe(false);
    expect(isExpenseReconcileQuery('summarize yesterday')).toBe(false);
    expect(isExpenseReconcileQuery('')).toBe(false);
  });
});

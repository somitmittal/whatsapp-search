import { describe, test, expect } from '@jest/globals';
import {
  MODEL_TIERS,
  RAM_BUDGET_RATIO,
  computeModelBudgetGb,
  pickModelTierForBudget,
  resolveSafeOllamaModel,
  numCtxForBudget,
} from '../src/llm/ollama-recommend.js';

describe('ollama-recommend', () => {
  test('RAM_BUDGET_RATIO is 60%', () => {
    expect(RAM_BUDGET_RATIO).toBe(0.6);
  });

  test('budget is 60% of available', () => {
    expect(computeModelBudgetGb(10)).toBe(6);
    expect(computeModelBudgetGb(9)).toBe(5.4);
  });

  test('warn pressure shrinks budget', () => {
    expect(computeModelBudgetGb(10, 'warn')).toBe(4.5);
  });

  test('16 GB machine with ~9 GB available → llama3.2:3b', () => {
    expect(pickModelTierForBudget(9 * RAM_BUDGET_RATIO).model).toBe('llama3.2:3b');
  });

  test('~12 GB available → qwen3.5:4b', () => {
    expect(pickModelTierForBudget(12 * RAM_BUDGET_RATIO).model).toBe('qwen3.5:4b');
  });

  test('resolveSafeOllamaModel downgrades oversized request', () => {
    const safe = resolveSafeOllamaModel('gemma2:9b');
    if (safe.budgetGb < 10) {
      expect(safe.model).not.toBe('gemma2:9b');
      expect(safe.downgraded).toBe(true);
      expect(safe.warning).toBeTruthy();
    }
  });

  test('numCtx scales down on tight budgets', () => {
    expect(numCtxForBudget(10)).toBe(4096);
    expect(numCtxForBudget(5)).toBe(2048);
    expect(numCtxForBudget(2)).toBe(1536);
  });

  test('tiers are ordered largest-first', () => {
    for (let i = 1; i < MODEL_TIERS.length; i++) {
      expect(MODEL_TIERS[i - 1].minBudgetGb).toBeGreaterThanOrEqual(MODEL_TIERS[i].minBudgetGb);
    }
  });
});

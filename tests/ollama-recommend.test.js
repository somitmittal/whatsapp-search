import { describe, test, expect } from '@jest/globals';
import {
  MODEL_TIERS,
  RAM_BUDGET_RATIO,
  computeModelBudgetGb,
  pickModelTierForBudget,
  pickInstalledFitTier,
  resolveSafeOllamaModel,
  resolveStartupOllamaModel,
  isAutoDownloadModel,
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

  test('resolveSafeOllamaModel warns but keeps oversized request', () => {
    const safe = resolveSafeOllamaModel('gemma2:9b');
    expect(safe.model).toBe('gemma2:9b');
    expect(safe.downgraded).toBe(false);
    if (safe.budgetGb < 10) {
      expect(safe.exceedsBudget).toBe(true);
      expect(safe.warning).toMatch(/gemma2:9b/);
      expect(safe.warning).not.toMatch(/Using .* instead/i);
      expect(safe.suggestedModel).toBeTruthy();
    }
  });

  test('auto-download allows 3B and below, not 9B', () => {
    expect(isAutoDownloadModel('llama3.2:1b')).toBe(true);
    expect(isAutoDownloadModel('llama3.2:3b')).toBe(true);
    expect(isAutoDownloadModel('gemma2:9b')).toBe(false);
    expect(isAutoDownloadModel('qwen3.5:4b')).toBe(false);
  });

  test('best-fit recommendation on a large budget is gemma2:9b', () => {
    expect(pickModelTierForBudget(12).model).toBe('gemma2:9b');
  });

  test('installed-fit prefers 3B over 1B when both are present', () => {
    const pick = pickInstalledFitTier(12, ['llama3.2:3b', 'llama3.2:1b']);
    expect(pick.model).toBe('llama3.2:3b');
  });

  test('startup skips pulling gemma2:9b when a smaller model is already installed', () => {
    const resolved = resolveStartupOllamaModel({
      requestedModel: 'gemma2:9b',
      localModels: ['llama3.2:1b'],
      budgetGb: 12,
    });
    expect(resolved.model).toBe('llama3.2:1b');
    expect(resolved.reason).toMatch(/skip-download/);
  });

  test('startup keeps gemma2:9b if it is already on disk', () => {
    const resolved = resolveStartupOllamaModel({
      requestedModel: 'gemma2:9b',
      localModels: ['gemma2:9b'],
      budgetGb: 12,
    });
    expect(resolved.model).toBe('gemma2:9b');
    expect(resolved.reason).toBe('keep-installed');
  });

  test('startup does not invent an installed model when none exist — waits for confirm', () => {
    const resolved = resolveStartupOllamaModel({
      requestedModel: 'gemma2:9b',
      localModels: [],
      budgetGb: 12,
    });
    expect(resolved.model).toBe('gemma2:9b');
    expect(resolved.reason).toBe('await-confirm');
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

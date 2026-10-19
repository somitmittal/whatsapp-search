import { describe, expect, test } from '@jest/globals';
import { paywallErrorMessage, paywallResponse } from '../src/control-plane/entitlement-check.js';
import { trialDays } from '../src/control-plane/license.js';

describe('GPT auth paywall', () => {
  test('trial length stays at 14 days', () => {
    expect(trialDays()).toBe(14);
  });

  test('GPT paywall copy differs from AI search', () => {
    expect(paywallErrorMessage('trial_expired', 'gpt')).toContain('WhatsApp GPT');
    expect(paywallErrorMessage('account_required', 'gpt')).toContain('WhatsApp GPT');
    expect(paywallErrorMessage('trial_expired', 'search')).toContain('AI search');
    expect(paywallErrorMessage('account_required', 'search')).toContain('AI search');
  });

  test('paywallResponse returns 402 with product-aware error', () => {
    const captured = {};
    const res = {
      status(code) { captured.status = code; return this; },
      json(body) { captured.body = body; return captured; },
    };
    paywallResponse(
      res,
      { allowed: false, reason: 'trial_expired', plan: 'trial', status: 'trialing' },
      null,
      'inst_test',
      { product: 'gpt' },
    );
    expect(captured.status).toBe(402);
    expect(captured.body.code).toBe('trial_expired');
    expect(captured.body.error).toContain('WhatsApp GPT');
  });
});

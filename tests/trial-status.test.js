import { describe, expect, test } from '@jest/globals';
import {
  accountPlanSummary,
  daysLeftInTrial,
  isTrialExpired,
  msUntilTrialEnds,
  shouldAutoLogout,
} from '../public/js/trial-status.js';

const NOW = new Date(2026, 9, 19, 12, 0, 0).getTime();

describe('daysLeftInTrial', () => {
  test('returns null when the end date is missing', () => {
    expect(daysLeftInTrial(null, NOW)).toBeNull();
  });

  test('ceils partial days so the last day still shows 1', () => {
    const in12h = new Date(NOW + 12 * 3600000).toISOString();
    expect(daysLeftInTrial(in12h, NOW)).toBe(1);
  });

  test('counts whole remaining days from the server end date', () => {
    const in3d = new Date(NOW + 3 * 86400000).toISOString();
    expect(daysLeftInTrial(in3d, NOW)).toBe(3);
  });

  test('returns 0 once the trial has ended', () => {
    const past = new Date(NOW - 1000).toISOString();
    expect(daysLeftInTrial(past, NOW)).toBe(0);
  });
});

describe('trial expiry / auto-logout', () => {
  test('trial_expired reason forces logout', () => {
    expect(shouldAutoLogout({ reason: 'trial_expired', plan: 'trial', trialEndsAt: new Date(NOW - 1).toISOString() }, NOW)).toBe(true);
  });

  test('active trial does not auto-logout', () => {
    const ends = new Date(NOW + 86400000).toISOString();
    expect(isTrialExpired({ plan: 'trial', status: 'trialing', trialEndsAt: ends }, NOW)).toBe(false);
    expect(shouldAutoLogout({ plan: 'trial', status: 'trialing', allowed: true, trialEndsAt: ends }, NOW)).toBe(false);
  });

  test('msUntilTrialEnds matches the server timestamp', () => {
    const ends = new Date(NOW + 5000).toISOString();
    expect(msUntilTrialEnds(ends, NOW)).toBe(5000);
    expect(msUntilTrialEnds(new Date(NOW - 1).toISOString(), NOW)).toBe(0);
  });
});

describe('accountPlanSummary', () => {
  test('reports days left for an active trial', () => {
    const ends = new Date(NOW + 5 * 86400000).toISOString();
    const summary = accountPlanSummary(
      { plan: 'trial', status: 'trialing', allowed: true, trialEndsAt: ends },
      { email: 'a@b.com' },
      NOW,
    );
    expect(summary.kind).toBe('trial');
    expect(summary.daysLeft).toBe(5);
    expect(summary.text).toBe('5 days left in trial');
  });

  test('uses singular copy on the last day', () => {
    const ends = new Date(NOW + 12 * 3600000).toISOString();
    expect(accountPlanSummary(
      { plan: 'trial', status: 'trialing', allowed: true, trialEndsAt: ends },
      {},
      NOW,
    ).text).toBe('1 day left in trial');
  });

  test('marks an ended trial', () => {
    const summary = accountPlanSummary(
      { plan: 'trial', status: 'expired', reason: 'trial_expired', trialEndsAt: new Date(NOW - 1).toISOString() },
      { email: 'a@b.com' },
      NOW,
    );
    expect(summary.kind).toBe('expired');
    expect(summary.daysLeft).toBe(0);
  });

  test('shows Pro when subscribed', () => {
    expect(accountPlanSummary({ plan: 'pro', status: 'active', allowed: true }, {}).kind).toBe('pro');
  });
});

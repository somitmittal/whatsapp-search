import { describe, expect, test } from '@jest/globals';
import {
  evaluateEntitlement,
  signLicenseToken,
  verifyLicenseToken,
  entitlementFromTokenPayload,
  offlineGraceMs,
} from '../src/control-plane/license.js';

describe('control-plane license', () => {
  test('allows active pro', () => {
    const e = evaluateEntitlement({ plan: 'pro', status: 'active' });
    expect(e.allowed).toBe(true);
    expect(e.plan).toBe('pro');
  });

  test('allows active trial before end date', () => {
    const trialEndsAt = new Date(Date.now() + 86400000).toISOString();
    const e = evaluateEntitlement({ plan: 'trial', status: 'trialing', trial_ends_at: trialEndsAt });
    expect(e.allowed).toBe(true);
  });

  test('rejects expired trial', () => {
    const trialEndsAt = new Date(Date.now() - 1000).toISOString();
    const e = evaluateEntitlement({ plan: 'trial', status: 'trialing', trial_ends_at: trialEndsAt });
    expect(e.allowed).toBe(false);
    expect(e.reason).toBe('trial_expired');
  });

  test('signs and verifies license tokens', () => {
    const secret = 'test-secret';
    const token = signLicenseToken({
      userId: 'usr_1',
      email: 'a@b.com',
      plan: 'trial',
      status: 'trialing',
      trialEndsAt: new Date(Date.now() + 86400000).toISOString(),
    }, secret);
    const payload = verifyLicenseToken(token, secret);
    expect(payload.email).toBe('a@b.com');
    expect(entitlementFromTokenPayload(payload).allowed).toBe(true);
  });

  test('rejects stale offline tokens', () => {
    const secret = 'test-secret';
    const token = signLicenseToken({ plan: 'pro', status: 'active' }, secret);
    const payload = verifyLicenseToken(token, secret, Date.now() + offlineGraceMs() + 1000);
    expect(payload._stale).toBe(true);
    expect(entitlementFromTokenPayload(payload).allowed).toBe(false);
  });
});

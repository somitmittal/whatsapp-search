import { afterEach, describe, expect, test } from '@jest/globals';
import {
  applyControlPlanePolicy,
  compareAppVersions,
  isAppBelowMin,
} from '../src/control-plane/app-policy.js';
import { evaluateEntitlement } from '../src/control-plane/license.js';

describe('control-plane app policy', () => {
  const prev = process.env.APP_MIN_VERSION;

  afterEach(() => {
    if (prev == null) delete process.env.APP_MIN_VERSION;
    else process.env.APP_MIN_VERSION = prev;
  });

  test('compares semver-ish versions', () => {
    expect(compareAppVersions('1.0.9', '1.0.10')).toBe(-1);
    expect(compareAppVersions('1.0.10', '1.0.10')).toBe(0);
    expect(compareAppVersions('v1.1.0', '1.0.99')).toBe(1);
  });

  test('force-update when below APP_MIN_VERSION', () => {
    process.env.APP_MIN_VERSION = '1.0.11';
    expect(isAppBelowMin('1.0.10')).toBe(true);
    expect(isAppBelowMin('1.0.11')).toBe(false);
    const { entitlement, policy } = applyControlPlanePolicy(
      { allowed: true, plan: 'pro', status: 'active', reason: null, trialEndsAt: null },
      { appVersion: '1.0.10', downloadUrl: 'https://example.com/download' },
    );
    expect(policy.updateRequired).toBe(true);
    expect(entitlement.allowed).toBe(false);
    expect(entitlement.reason).toBe('update_required');
    expect(entitlement.downloadUrl).toContain('/download');
  });

  test('remote lock disables entitlement', () => {
    const e = evaluateEntitlement({ plan: 'pro', status: 'disabled' });
    expect(e.allowed).toBe(false);
    expect(e.reason).toBe('account_locked');
  });
});

import { afterEach, describe, expect, test } from '@jest/globals';
import { isLicenseGateEnabled } from '../src/control-plane/license-gate.js';

describe('isLicenseGateEnabled', () => {
  const keys = [
    'LICENSE_GATE',
    'CONTROL_PLANE_URL',
    'CONTROL_PLANE_PUBLIC_URL',
    'DESKTOP_APP',
    'JWT_SECRET',
    'SESSION_SECRET',
  ];
  const prev = {};

  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
      delete prev[k];
    }
  });

  function snap() {
    for (const k of keys) prev[k] = process.env[k];
  }

  test('LICENSE_GATE=0 disables even with a hosted control plane URL', () => {
    snap();
    process.env.LICENSE_GATE = '0';
    process.env.CONTROL_PLANE_URL = 'https://example.onrender.com';
    delete process.env.JWT_SECRET;
    delete process.env.SESSION_SECRET;
    expect(isLicenseGateEnabled()).toBe(false);
  });

  test('LICENSE_GATE=1 with hosted URL enables the gate', () => {
    snap();
    process.env.LICENSE_GATE = '1';
    process.env.CONTROL_PLANE_URL = 'https://example.onrender.com';
    delete process.env.JWT_SECRET;
    delete process.env.SESSION_SECRET;
    expect(isLicenseGateEnabled()).toBe(true);
  });
});

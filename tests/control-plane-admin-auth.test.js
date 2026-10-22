import { afterEach, describe, expect, test } from '@jest/globals';
import {
  adminAuthorized,
  isAdminBasicConfigured,
  parseBasicAuth,
} from '../src/control-plane/admin-auth.js';

describe('control-plane admin auth', () => {
  const prev = {};

  afterEach(() => {
    for (const k of ['CONTROL_PLANE_ADMIN_USER', 'CONTROL_PLANE_ADMIN_PASSWORD', 'SESSION_SECRET', 'JWT_SECRET']) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  function snap() {
    for (const k of ['CONTROL_PLANE_ADMIN_USER', 'CONTROL_PLANE_ADMIN_PASSWORD', 'SESSION_SECRET', 'JWT_SECRET']) {
      prev[k] = process.env[k];
    }
  }

  test('parses basic auth header', () => {
    const token = Buffer.from('admin:s3cret', 'utf8').toString('base64');
    expect(parseBasicAuth(`Basic ${token}`)).toEqual({ user: 'admin', pass: 's3cret' });
  });

  test('accepts configured username/password', () => {
    snap();
    process.env.CONTROL_PLANE_ADMIN_USER = 'admin';
    process.env.CONTROL_PLANE_ADMIN_PASSWORD = 's3cret';
    delete process.env.SESSION_SECRET;
    delete process.env.JWT_SECRET;
    expect(isAdminBasicConfigured()).toBe(true);
    const token = Buffer.from('admin:s3cret', 'utf8').toString('base64');
    const req = { get: (h) => (h.toLowerCase() === 'authorization' ? `Basic ${token}` : '') };
    expect(adminAuthorized(req)).toBe(true);
    const bad = { get: () => `Basic ${Buffer.from('admin:wrong', 'utf8').toString('base64')}` };
    expect(adminAuthorized(bad)).toBe(false);
  });

  test('still accepts Bearer SESSION_SECRET', () => {
    snap();
    delete process.env.CONTROL_PLANE_ADMIN_USER;
    delete process.env.CONTROL_PLANE_ADMIN_PASSWORD;
    process.env.SESSION_SECRET = 'bearer-secret';
    const req = { get: () => 'Bearer bearer-secret' };
    expect(adminAuthorized(req)).toBe(true);
  });
});

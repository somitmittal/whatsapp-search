import { describe, expect, test, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  openControlPlaneStore,
  resetControlPlaneStoreForTests,
} from '../src/control-plane/store.js';
import { evaluateEntitlement } from '../src/control-plane/license.js';

describe('control-plane store', () => {
  let tmp;
  let store;

  afterEach(() => {
    resetControlPlaneStoreForTests();
    if (store) {
      try { store.close(); } catch { /* ignore */ }
      store = null;
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test('tracks downloads by platform and summarizes', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'cp-'));
    store = openControlPlaneStore(path.join(tmp, 'cp.db'));
    store.logAnalyticsEvent({
      event: 'download_clicked',
      platform: 'mac-arm64',
      version: 'v1.0.9',
      utmSource: 'linkedin',
    });
    store.logAnalyticsEvent({
      event: 'download_clicked',
      platform: 'windows',
      version: 'v1.0.9',
    });
    store.logAnalyticsEvent({
      event: 'download_clicked',
      platform: 'mac-arm64',
      version: 'v1.0.9',
    });
    const summary = store.downloadSummary();
    expect(summary.total).toBe(3);
    const mac = summary.byPlatform.find((r) => r.platform === 'mac-arm64');
    expect(mac.count).toBe(2);
  });

  test('magic link → trial license for install', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'cp-'));
    store = openControlPlaneStore(path.join(tmp, 'cp.db'));
    const { token, code } = store.createMagicLink({
      email: 'founder@example.com',
      installId: 'inst_abc',
      utmSource: 'linkedin',
    });
    expect(token).toBeTruthy();
    expect(code).toHaveLength(6);
    const row = store.consumeMagicLinkByCode('founder@example.com', code);
    expect(row.email).toBe('founder@example.com');
    const user = store.upsertUser({ email: row.email, utmSource: row.utm_source });
    store.upsertDevice({ installId: 'inst_abc', userId: user.id, os: 'darwin' });
    const license = store.createTrialLicense(user.id, 14);
    const entitlement = evaluateEntitlement(license);
    expect(entitlement.allowed).toBe(true);
    expect(store.getLicenseForInstall('inst_abc').id).toBe(license.id);
  });

  test('admin can remotely lock and restore a license', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'cp-'));
    store = openControlPlaneStore(path.join(tmp, 'cp.db'));
    const user = store.upsertUser({ email: 'lockme@example.com' });
    store.upsertDevice({ installId: 'inst_lock', userId: user.id });
    store.createTrialLicense(user.id, 14);
    const locked = store.setLicenseStatusByEmail('lockme@example.com', 'disabled');
    expect(evaluateEntitlement(locked.license).reason).toBe('account_locked');
    const restored = store.setLicenseStatusByEmail('lockme@example.com', 'trialing');
    expect(evaluateEntitlement(restored.license).allowed).toBe(true);
  });
});

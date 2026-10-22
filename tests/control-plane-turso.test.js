import { afterEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { evaluateEntitlement } from '../src/control-plane/license.js';
import { openTursoControlPlaneStore } from '../src/control-plane/store-turso.js';

describe('control-plane Turso/libSQL store', () => {
  let tmp;
  let store;

  afterEach(async () => {
    if (store) {
      try { store.close(); } catch { /* ignore */ }
      store = null;
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  test('persists trial license on a local libSQL file', async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'turso-cp-'));
    const fileUrl = pathToFileURL(path.join(tmp, 'cp.db')).href;
    store = await openTursoControlPlaneStore({ url: fileUrl });

    const user = await store.upsertUser({ email: 'turso@example.com' });
    await store.upsertDevice({ installId: 'inst_turso', userId: user.id, os: 'test' });
    const license = await store.createTrialLicense(user.id, 14);
    expect(evaluateEntitlement(license).allowed).toBe(true);
    expect((await store.getLicenseForInstall('inst_turso')).id).toBe(license.id);

    const locked = await store.setLicenseStatusByEmail('turso@example.com', 'disabled');
    expect(evaluateEntitlement(locked.license).reason).toBe('account_locked');
  });
});

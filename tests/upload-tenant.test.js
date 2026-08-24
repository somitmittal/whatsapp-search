import { describe, expect, test } from '@jest/globals';
import { preserveTenantAcrossUpload } from '../src/web/upload-tenant.js';
import { getCurrentTenantId, runWithTenant, tenantContext } from '../src/storage/tenant-context.js';
import { LEGACY_TENANT_ID } from '../src/storage/tenant-constants.js';

/** Stands in for multer, which resolves its busboy pipeline detached from the request's context. */
function detachedUpload(req, res, next) {
  tenantContext.exit(() => setImmediate(() => next()));
}

describe('preserveTenantAcrossUpload', () => {
  test('handler behind the upload still sees the request tenant', async () => {
    const seen = await new Promise((resolve) => {
      runWithTenant('tenant-a', () => {
        preserveTenantAcrossUpload(detachedUpload)({}, {}, () => resolve(getCurrentTenantId()));
      });
    });
    expect(seen).toBe('tenant-a');
  });

  test('an unwrapped upload leaks into the legacy tenant (regression guard)', async () => {
    const seen = await new Promise((resolve) => {
      runWithTenant('tenant-a', () => {
        detachedUpload({}, {}, () => resolve(getCurrentTenantId()));
      });
    });
    expect(seen).toBe(LEGACY_TENANT_ID);
  });

  test('upload errors reach the next handler with the tenant restored', async () => {
    const failing = (req, res, next) => tenantContext.exit(() => next(new Error('file too large')));
    const result = await new Promise((resolve) => {
      runWithTenant('tenant-b', () => {
        preserveTenantAcrossUpload(failing)({}, {}, (err) => {
          resolve({ message: err?.message, tenantId: getCurrentTenantId() });
        });
      });
    });
    expect(result).toEqual({ message: 'file too large', tenantId: 'tenant-b' });
  });
});

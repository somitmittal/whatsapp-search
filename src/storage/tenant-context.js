import { AsyncLocalStorage } from 'node:async_hooks';
import { LEGACY_TENANT_ID } from './tenant-constants.js';

/** Request/job-scoped tenant id for shared SQLite (row-level isolation). */
export const tenantContext = new AsyncLocalStorage();

export function getCurrentTenantId() {
  const id = tenantContext.getStore()?.tenantId;
  return typeof id === 'string' && id.length ? id : LEGACY_TENANT_ID;
}

/**
 * Run `fn` with tenant id bound (sync or async).
 * @template T
 * @param {string} tenantId
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithTenant(tenantId, fn) {
  const id = typeof tenantId === 'string' && tenantId.length ? tenantId : LEGACY_TENANT_ID;
  return tenantContext.run({ tenantId: id }, fn);
}

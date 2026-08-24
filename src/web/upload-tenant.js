import { getCurrentTenantId, runWithTenant } from '../storage/tenant-context.js';

/**
 * multer resolves its busboy pipeline outside the request's AsyncLocalStorage scope, so a
 * route handler behind `upload.array(...)` sees no tenant and `getCurrentTenantId()` falls
 * back to the legacy tenant — uploads then land where the caller's session never reads them.
 * Capture the tenant while the context is still intact and re-enter it for the handler.
 *
 * @param {(req: any, res: any, next: (err?: any) => void) => void} uploadMiddleware
 * @returns {(req: any, res: any, next: (err?: any) => void) => void}
 */
export function preserveTenantAcrossUpload(uploadMiddleware) {
  return (req, res, next) => {
    const tenantId = getCurrentTenantId();
    uploadMiddleware(req, res, (err) => runWithTenant(tenantId, () => next(err)));
  };
}

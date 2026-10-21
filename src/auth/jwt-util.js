import config from '../config.js';

/**
 * @returns {string} Server-only secret (from SESSION_SECRET or JWT_SECRET in env). Not a user-facing token.
 * Reads env at call time so runtime/config changes and tests are not stuck on import-time cache.
 */
export function getServerSecret() {
  const fromEnv = (process.env.SESSION_SECRET || process.env.JWT_SECRET || '').trim();
  if (fromEnv) return fromEnv;
  return (config.serverSecret || '').trim();
}

/** "Multi-tenant" mode: sessions in DB + httpOnly cookies when a server secret is set. */
export function isJwtAuthEnabled() {
  return !!getServerSecret();
}

export { LEGACY_TENANT_ID } from '../storage/tenant-constants.js';

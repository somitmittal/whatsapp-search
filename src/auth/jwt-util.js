import jwt from 'jsonwebtoken';
import config from '../config.js';

function getSecret() {
  return (process.env.JWT_SECRET || config.jwtSecret || '').trim();
}

/** When unset, server runs legacy single-user mode (no login). */
export function isJwtAuthEnabled() {
  return !!getSecret();
}

export function signTenantToken(tenantId, email) {
  const secret = getSecret();
  if (!secret) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(
    { sub: tenantId, email: email || null },
    secret,
    { expiresIn: '30d' },
  );
}

/**
 * @returns {{ tenantId: string, email: string | null } | null}
 */
export function verifyTenantToken(token) {
  const secret = getSecret();
  if (!secret || !token) return null;
  try {
    const p = jwt.verify(String(token).trim(), secret);
    const tenantId = p.sub || p.tenantId;
    if (!tenantId || typeof tenantId !== 'string') return null;
    return { tenantId, email: p.email || null };
  } catch {
    return null;
  }
}

export { LEGACY_TENANT_ID } from '../storage/tenant-constants.js';

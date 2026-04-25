import crypto from 'node:crypto';

function getJwtSecret() {
  return String(process.env.JWT_SECRET || '').trim();
}

/**
 * Derive a stable per-tenant key from JWT_SECRET (32 bytes).
 * This lets us store encrypted-at-rest contact names without keeping plaintext in SQLite.
 */
export function deriveTenantContactKey(tenantId) {
  const secret = getJwtSecret();
  if (!secret) throw new Error('JWT_SECRET is required for contact sync encryption');
  return crypto
    .createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`contacts:v1:${String(tenantId || '')}`)
    .digest(); // 32 bytes
}

/**
 * Normalize a phone-like string into digits-only E.164-ish form (no leading +).
 * This is intentionally conservative; WhatsApp JIDs already contain the canonical digits.
 */
export function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // keep digits only
  const digits = s.replace(/[^\d]/g, '');
  return digits;
}

export function hashPhone(tenantKey, normalizedDigits) {
  const d = String(normalizedDigits || '');
  if (!d) return '';
  // HMAC prevents rainbow table lookup vs plain sha256(phone)
  return crypto.createHmac('sha256', tenantKey).update(d).digest('hex');
}

export function encryptName(tenantKey, name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tenantKey, iv);
  const enc = Buffer.concat([cipher.update(n, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // store as base64 components
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decryptName(tenantKey, payload) {
  const p = String(payload || '');
  if (!p) return '';
  const [ivB64, tagB64, encB64] = p.split('.');
  if (!ivB64 || !tagB64 || !encB64) return '';
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', tenantKey, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  return out.toString('utf8');
}


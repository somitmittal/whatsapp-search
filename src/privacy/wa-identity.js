import crypto from 'node:crypto';
import config from '../config.js';

function getSecret() {
  return String(config.serverSecret || '').trim();
}

/**
 * Hash WhatsApp owner JID (or phone digits) to a stable, non-PII key.
 * @param {string} ownerJid
 * @returns {string}
 */
export function hashWhatsAppOwnerId(ownerJid) {
  const secret = getSecret();
  if (!secret) throw new Error('Set SESSION_SECRET (or JWT_SECRET) to enable WhatsApp identity mapping');
  const normalized = String(ownerJid || '').trim().toLowerCase();
  return crypto
    .createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`waid:v1:${normalized}`)
    .digest('hex');
}


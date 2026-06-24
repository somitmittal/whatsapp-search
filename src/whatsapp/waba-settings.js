/** SQLite settings keys for WhatsApp Cloud API (Business Platform). */

export const WABA_PHONE_NUMBER_ID = 'waba_phone_number_id';
export const WABA_ACCESS_TOKEN = 'waba_access_token';
export const WABA_VERIFY_TOKEN = 'waba_verify_token';
export const WABA_APP_SECRET = 'waba_app_secret';
export const WABA_BUSINESS_ACCOUNT_ID = 'waba_business_account_id';
export const WABA_LAST_WEBHOOK_AT = 'waba_last_webhook_at';
export const WABA_LAST_ERROR = 'waba_last_error';
export const WABA_MESSAGES_RECEIVED = 'waba_messages_received';

/**
 * @param {import('../storage/database.js').default} db
 */
export function getWabaConfig(db) {
  return {
    phoneNumberId: (db.getSetting(WABA_PHONE_NUMBER_ID) || '').trim(),
    accessToken: (db.getSetting(WABA_ACCESS_TOKEN) || '').trim(),
    verifyToken: (db.getSetting(WABA_VERIFY_TOKEN) || '').trim(),
    appSecret: (db.getSetting(WABA_APP_SECRET) || '').trim(),
    businessAccountId: (db.getSetting(WABA_BUSINESS_ACCOUNT_ID) || '').trim(),
    lastWebhookAt: Number(db.getSetting(WABA_LAST_WEBHOOK_AT) || 0) || null,
    lastError: (db.getSetting(WABA_LAST_ERROR) || '').trim() || null,
    messagesReceived: Number(db.getSetting(WABA_MESSAGES_RECEIVED) || 0) || 0,
  };
}

/**
 * @param {import('../storage/database.js').default} db
 */
export function publicWabaConfig(db) {
  const c = getWabaConfig(db);
  return {
    configured: !!(c.phoneNumberId && c.accessToken && c.verifyToken),
    phoneNumberId: c.phoneNumberId,
    businessAccountId: c.businessAccountId,
    hasAccessToken: !!c.accessToken,
    hasAppSecret: !!c.appSecret,
    lastWebhookAt: c.lastWebhookAt,
    lastError: c.lastError,
    messagesReceived: c.messagesReceived,
  };
}

/**
 * @param {import('../storage/database.js').default} db
 * @param {object} body
 */
export function saveWabaConfig(db, body) {
  if (Object.prototype.hasOwnProperty.call(body, 'phoneNumberId')) {
    db.setSetting(WABA_PHONE_NUMBER_ID, String(body.phoneNumberId ?? '').trim());
  }
  if (Object.prototype.hasOwnProperty.call(body, 'accessToken')) {
    db.setSetting(WABA_ACCESS_TOKEN, String(body.accessToken ?? '').trim());
  }
  if (Object.prototype.hasOwnProperty.call(body, 'verifyToken')) {
    db.setSetting(WABA_VERIFY_TOKEN, String(body.verifyToken ?? '').trim());
  }
  if (Object.prototype.hasOwnProperty.call(body, 'appSecret')) {
    db.setSetting(WABA_APP_SECRET, String(body.appSecret ?? '').trim());
  }
  if (Object.prototype.hasOwnProperty.call(body, 'businessAccountId')) {
    db.setSetting(WABA_BUSINESS_ACCOUNT_ID, String(body.businessAccountId ?? '').trim());
  }
}

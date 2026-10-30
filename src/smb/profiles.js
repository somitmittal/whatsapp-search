/**
 * Expense site allowlist + legacy personal profile stubs.
 * Vertical SMB profiles (clinic / real estate / D2C / construction) were removed —
 * expense reconciliation no longer requires a construction profile or agent toggle.
 */

export const SMB_PROFILE_SETTING = 'smb_profile';
export const SMB_BUSINESS_NAME_SETTING = 'smb_business_name';
/** @deprecated Kept for DB compatibility; expense agent is always available. */
export const CONSTRUCTION_EXPENSE_AGENT_SETTING = 'construction_expense_agent';
/** JSON array of group chat JIDs allowed to auto-run when a sheet is posted. Empty = no auto-run. */
export const CONSTRUCTION_EXPENSE_SITE_JIDS_SETTING = 'construction_expense_site_jids';

/** @typedef {'personal'} SmbProfileId */

/** @type {Record<SmbProfileId, object>} */
export const SMB_PROFILES = {
  personal: {
    id: 'personal',
    label: 'Personal',
    tagline: 'Search your chats',
    isBusiness: false,
  },
};

/**
 * Expense reconciliation is always available (no profile / agent toggle).
 * @param {import('../storage/database.js').default} [_db]
 * @returns {boolean}
 */
export function isConstructionExpenseAgentEnabled(_db) {
  return true;
}

/**
 * @param {import('../storage/database.js').default} db
 * @returns {string[]}
 */
export function getConstructionExpenseSiteJids(db) {
  if (!db || typeof db.getSetting !== 'function') return [];
  const raw = db.getSetting(CONSTRUCTION_EXPENSE_SITE_JIDS_SETTING);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((j) => String(j || '').trim()).filter((j) => j.endsWith('@g.us')))];
  } catch {
    return [];
  }
}

/**
 * Auto-run only on sites the user selected. Manual "Run for chat" bypasses this.
 * @param {import('../storage/database.js').default} db
 * @param {string} chatJid
 */
export function isConstructionExpenseSiteAllowed(db, chatJid) {
  const jid = String(chatJid || '').trim();
  if (!jid.endsWith('@g.us')) return false;
  return getConstructionExpenseSiteJids(db).includes(jid);
}

/**
 * @param {string | null | undefined} [_id]
 * @returns {typeof SMB_PROFILES.personal}
 */
export function resolveSmbProfile(_id) {
  return SMB_PROFILES.personal;
}

/**
 * @param {import('../storage/database.js').default} [_db]
 * @returns {typeof SMB_PROFILES.personal}
 */
export function getSmbProfileFromDb(_db) {
  return SMB_PROFILES.personal;
}

/**
 * @param {typeof SMB_PROFILES.personal} [_profile]
 * @returns {Array<{ label: string, query: string }>}
 */
export function getSearchPrompts(_profile) {
  return [];
}

/**
 * @param {typeof SMB_PROFILES.personal} [_profile]
 * @returns {string}
 */
export function synthesisSystemAddon(_profile) {
  return '';
}

/**
 * @param {typeof SMB_PROFILES.personal} [_profile]
 * @returns {string}
 */
export function factExtractionAddon(_profile) {
  return '';
}

/**
 * @param {typeof SMB_PROFILES.personal} [_profile]
 * @returns {string}
 */
export function actionItemAddon(_profile) {
  return '';
}

/**
 * @param {typeof SMB_PROFILES.personal} [_profile]
 * @returns {string}
 */
export function inboxFactSearchQuery(_profile) {
  return '';
}

/**
 * @returns {Array<{ id: string, label: string, tagline: string, isBusiness: boolean }>}
 */
export function listSmbProfileOptions() {
  return Object.values(SMB_PROFILES).map((p) => ({
    id: p.id,
    label: p.label,
    tagline: p.tagline,
    isBusiness: !!p.isBusiness,
  }));
}

/**
 * Profiles removed — never flag a library mismatch.
 * @param {import('../storage/database.js').default} [_db]
 * @returns {{ mismatch: boolean, reason?: string }}
 */
export function detectSmbLibraryMismatch(_db) {
  return { mismatch: false };
}

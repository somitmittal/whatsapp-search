import {
  getSmbProfileFromDb,
  inboxFactSearchQuery,
  resolveSmbProfile,
} from './profiles.js';

function parseFactPayload(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payloadJson || '{}');
  } catch { /* */ }
  return {
    id: row.id,
    chatJid: row.chatJid,
    chatName: row.chatName,
    factType: row.factType,
    threadStart: row.threadStart,
    threadEnd: row.threadEnd,
    payload,
    summary: payload.summary || payload.about || payload.topic || payload.product || payload.reason || '',
  };
}

export default class SmbInboxService {
  /** @param {import('../storage/database.js').default} db */
  constructor(db) {
    this.db = db;
  }

  /**
   * @param {string | null} profileId
   * @returns {object}
   */
  getDashboard(profileId = null) {
    const profile = profileId ? resolveSmbProfile(profileId) : getSmbProfileFromDb(this.db);
    if (!profile.isBusiness) {
      return { profile, enabled: false, awaitingReply: [], followUps: [], highlights: [] };
    }

    const businessName = (this.db.getSetting('smb_business_name') || '').trim() || null;
    const awaitingReply = this.db.getChatsAwaitingReply(15);
    const followUps = this.db.getAllActionItemsAcrossChats(20);

    const factQuery = inboxFactSearchQuery(profile);
    const factRows = factQuery ? this.db.searchFacts(factQuery, null, 12) : [];
    const highlights = factRows.map(parseFactPayload);

    return {
      profile: {
        id: profile.id,
        label: profile.label,
        tagline: profile.tagline,
      },
      businessName,
      enabled: true,
      awaitingReply,
      followUps,
      highlights,
      stats: {
        awaitingReplyCount: awaitingReply.length,
        followUpCount: followUps.length,
        highlightCount: highlights.length,
      },
    };
  }
}

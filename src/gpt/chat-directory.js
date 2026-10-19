import Fuse from 'fuse.js';
import { getCurrentTenantId } from '../storage/tenant-context.js';
import { GPT_LIMITS } from './limits.js';

/** Cached per-tenant chat list so name lookups don't rerun the heavy chat-stats query every turn. */
export default class ChatDirectory {
  constructor(db) {
    this.db = db;
    this._cache = new Map();
  }

  list() {
    const tenant = getCurrentTenantId();
    const hit = this._cache.get(tenant);
    if (hit && Date.now() - hit.at < GPT_LIMITS.directoryTtlMs) return hit;
    const chats = (this.db.getChatStats() || [])
      .filter((c) => c.chatJid && c.chatJid !== 'status@broadcast')
      .map((c) => ({
        chatJid: c.chatJid,
        chatName: c.chatName || c.chatJid,
        messageCount: c.messageCount || 0,
        lastMessageTs: c.lastMessageTs || 0,
      }))
      .sort((a, b) => b.lastMessageTs - a.lastMessageTs);
    const entry = {
      at: Date.now(),
      chats,
      byJid: new Map(chats.map((c) => [c.chatJid, c])),
      fuse: new Fuse(chats, { keys: ['chatName'], threshold: 0.4, ignoreLocation: true, minMatchCharLength: 2 }),
    };
    this._cache.set(tenant, entry);
    return entry;
  }

  name(chatJid) {
    if (!chatJid) return null;
    const known = this.list().byJid.get(chatJid);
    if (known) return known.chatName;
    return this.db.getQuickChatInfo(chatJid)?.chatName || chatJid;
  }

  /**
   * Resolve business/brand shorthand that appears in the conversation but is not part
   * of WhatsApp's saved chat title (for example, a broker name in a direct chat).
   * Search indexed message text and rank chats by repeated evidence.
   */
  _searchMessageAliases(query, dir, limit) {
    const q = String(query || '').trim();
    if (q.length < 2 || typeof this.db.searchMessages !== 'function') return [];
    let hits = [];
    try { hits = this.db.searchMessages(q, null, 150) || []; } catch { return []; }
    const byJid = new Map();
    for (const hit of hits) {
      if (!hit?.chatJid || !dir.byJid.has(hit.chatJid)) continue;
      const current = byJid.get(hit.chatJid) || { count: 0, rank: Infinity };
      current.count += 1;
      if (Number.isFinite(Number(hit.rank))) current.rank = Math.min(current.rank, Number(hit.rank));
      byJid.set(hit.chatJid, current);
    }
    return [...byJid.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[1].rank - b[1].rank)
      .slice(0, limit)
      .map(([jid]) => dir.byJid.get(jid));
  }

  /** Accepts a JID or a (fuzzy) chat name; returns the best chat or null. */
  resolve(ref) {
    const q = String(ref || '').trim().replace(/^@/, '');
    if (!q) return null;
    const dir = this.list();
    if (dir.byJid.has(q)) return dir.byJid.get(q);
    const lower = q.toLowerCase();
    const exact = dir.chats.find((c) => c.chatName.toLowerCase() === lower);
    if (exact) return exact;
    const byTitleFragment = dir.chats.find((c) => c.chatName.toLowerCase().includes(lower));
    if (byTitleFragment) return byTitleFragment;
    const byMessage = this._searchMessageAliases(q, dir, 1)[0];
    if (byMessage) return byMessage;
    return dir.fuse.search(q, { limit: 1 })[0]?.item || null;
  }

  search(query, limit = 10) {
    const dir = this.list();
    const q = String(query || '').trim();
    if (!q) return dir.chats.slice(0, limit);
    const direct = dir.fuse.search(q, { limit }).map((r) => r.item);
    if (direct.length >= limit) return direct;
    const seen = new Set(direct.map((c) => c.chatJid));
    const aliases = this._searchMessageAliases(q, dir, limit)
      .filter((c) => !seen.has(c.chatJid));
    return [...direct, ...aliases].slice(0, limit);
  }
}

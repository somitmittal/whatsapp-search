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

  /** Accepts a JID or a (fuzzy) chat name; returns the best chat or null. */
  resolve(ref) {
    const q = String(ref || '').trim().replace(/^@/, '');
    if (!q) return null;
    const dir = this.list();
    if (dir.byJid.has(q)) return dir.byJid.get(q);
    const lower = q.toLowerCase();
    const exact = dir.chats.find((c) => c.chatName.toLowerCase() === lower);
    if (exact) return exact;
    return dir.fuse.search(q, { limit: 1 })[0]?.item || null;
  }

  search(query, limit = 10) {
    const dir = this.list();
    const q = String(query || '').trim();
    if (!q) return dir.chats.slice(0, limit);
    return dir.fuse.search(q, { limit }).map((r) => r.item);
  }
}

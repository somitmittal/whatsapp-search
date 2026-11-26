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
    const byJid = new Map();
    for (const c of chats) {
      byJid.set(c.chatJid, c);
      if (typeof this.db.getLinkedJids === 'function') {
        const linked = this.db.getLinkedJids(c.chatJid);
        for (const alt of linked) {
          if (!byJid.has(alt)) byJid.set(alt, c);
        }
      }
    }

    const entry = {
      at: Date.now(),
      chats,
      byJid,
      fuse: new Fuse(chats, { keys: ['chatName'], threshold: 0.4, ignoreLocation: true, minMatchCharLength: 2 }),
    };
    this._cache.set(tenant, entry);
    return entry;
  }

  name(chatJid) {
    if (!chatJid) return null;
    const dir = this.list();
    const isQualityName = (n) => n && typeof n === 'string' && !n.includes('@') && !n.startsWith('Contact (');
    const known = dir.byJid.get(chatJid);
    if (known && isQualityName(known.chatName)) return known.chatName;
    if (typeof this.db.getLinkedJids === 'function') {
      const linked = this.db.getLinkedJids(chatJid);
      for (const alt of linked) {
        const lk = dir.byJid.get(alt);
        if (lk && isQualityName(lk.chatName)) return lk.chatName;
      }
    }
    if (known && known.chatName && !known.chatName.includes('@')) return known.chatName;
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
    // JIDs must never be tokenized as message text (prevents matching arbitrary group chats)
    if (/@(s\.whatsapp\.net|lid|g\.us|hosted|imported|broadcast|newsletter|bot)$/i.test(q)) return [];
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

    const isJidPattern = /@(s\.whatsapp\.net|lid|g\.us|hosted|imported|broadcast|newsletter|bot)$/i.test(q);
    if (isJidPattern) {
      if (typeof this.db.getLinkedJids === 'function') {
        const linked = this.db.getLinkedJids(q);
        for (const alt of linked) {
          if (dir.byJid.has(alt)) return dir.byJid.get(alt);
        }
      }
      const quick = this.db.getQuickChatInfo?.(q);
      if (quick) return { chatJid: q, chatName: quick.chatName || q, messageCount: 0, lastMessageTs: 0 };
      // Never fall through to searchMessageAliases or fuzzy search for a technical JID
      return null;
    }

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
    const rawList = !q
      ? dir.chats.slice(0, limit * 2)
      : (() => {
          const direct = dir.fuse.search(q, { limit: limit * 2 }).map((r) => r.item);
          if (direct.length >= limit * 2) return direct;
          const seenJids = new Set(direct.map((c) => c.chatJid));
          const aliases = this._searchMessageAliases(q, dir, limit)
            .filter((c) => !seenJids.has(c.chatJid));
          return [...direct, ...aliases];
        })();
    // Deduplicate linked/shadow JIDs sharing the same display title, keeping the richest one.
    const byName = new Map();
    for (const c of rawList) {
      const key = String(c.chatName || c.chatJid).trim().toLowerCase();
      const prev = byName.get(key);
      if (!prev || (c.messageCount || 0) > (prev.messageCount || 0)) {
        byName.set(key, c);
      }
    }
    return [...byName.values()].slice(0, limit);
  }
}

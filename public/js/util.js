export const $ = s => document.querySelector(s);

export const $$ = s => document.querySelectorAll(s);

// ── Utils ──────────────────────────────────────────────────────────
export function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

/** Escape for double-quoted HTML attributes (data-chat-jid, etc.). */
export function escAttr(s) {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/\r?\n/g, ' ');
}

export function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h); }

/**
 * Whether a `new-messages` / media WS payload should refresh the open transcript.
 * Prefer chatTouches / chatJid when present so other chats don't thrash the hover toolbar.
 *
 * Live WA 1:1 traffic often uses @lid while the open chat is @s.whatsapp.net (or the
 * reverse). Pass `linkedJids` (from store.activeChatLinkedJids) so those still match.
 */
export function eventTouchesChat(data, chatJid, linkedJids = null) {
  if (!chatJid) return false;
  const aliases = new Set(
    [chatJid, ...(Array.isArray(linkedJids) ? linkedJids : [])]
      .filter(Boolean)
      .map(String),
  );
  if (data?.chatJid && aliases.has(String(data.chatJid))) return true;
  const touches = data?.chatTouches;
  if (!Array.isArray(touches) || !touches.length) return true; // legacy / import broadcasts
  return touches.some((t) => t?.chatJid && aliases.has(String(t.chatJid)));
}

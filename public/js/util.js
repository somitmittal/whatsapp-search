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
 */
export function eventTouchesChat(data, chatJid) {
  if (!chatJid) return false;
  if (data?.chatJid && data.chatJid === chatJid) return true;
  const touches = data?.chatTouches;
  if (!Array.isArray(touches) || !touches.length) return true; // legacy / import broadcasts
  return touches.some((t) => t?.chatJid === chatJid);
}

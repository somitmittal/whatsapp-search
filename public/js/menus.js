import { store } from './store.js';
import { openChat } from './chat-view.js';
import { refreshDash, setChatIndexEnabled } from './dashboard.js';
import { switchPanel } from './overlays.js';
import { $ } from './util.js';

export function closeMenu() { $('#sidebar-menu').classList.remove('open'); }

function closeChatMenu() { $('#chat-menu').classList.remove('open'); }

export function closeAllMenus() { closeMenu(); closeChatMenu(); }

export function activeChatHasLocalMessages() {
  if (store.chatMessagesOffset > 0) return true;
  const ch = store.chatData.find((c) => c.chatJid === store.activeChat);
  return (ch?.messageCount || 0) > 0;
}

/**
 * WhatsApp's on-demand history sync walks backwards from a message we already hold — the
 * request carries that message's id as its cursor. A chat we only know by title has no
 * cursor to send, so the action is disabled rather than left to fail.
 */
const FETCH_OLDER_NEEDS_ANCHOR = 'Needs one message in this chat to sync backwards from — '
  + 'waiting for the first message to arrive.';

function syncFetchOlderMenuItem() {
  const item = $('#menu-fetch-older-history');
  if (!item) return;
  const usable = activeChatHasLocalMessages();
  item.classList.toggle('disabled', !usable);
  item.title = usable
    ? 'Uses WhatsApp on-demand sync — phone must be online'
    : FETCH_OLDER_NEEDS_ANCHOR;
}

export function syncIndexChatMenuItem() {
  const item = $('#menu-index-chat');
  if (!item) return;
  const ch = store.chatData.find((c) => c.chatJid === store.activeChat);
  const hasMessages = (ch?.messageCount || 0) > 0;
  const opted = !!ch?.indexOptedIn;
  item.classList.toggle('disabled', !hasMessages);
  if (!hasMessages) {
    item.title = 'Needs at least one stored message before it can be indexed';
    item.textContent = 'Index for AI search';
  } else if (opted) {
    item.title = 'Turn off AI indexing for this chat';
    item.textContent = 'Stop AI indexing';
  } else {
    item.title = 'Index this chat for AI search (off by default)';
    item.textContent = 'Index for AI search';
  }
}

export function showSidebarContextMenu(e, jid) {
  e.preventDefault();
  store._ctxMenuJid = jid;
  const menu = $('#sidebar-ctx-menu');
  menu.style.display = 'block';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
}

function closeSidebarContextMenu() {
  $('#sidebar-ctx-menu').style.display = 'none';
  store._ctxMenuJid = null;
}

function promptDeleteChat(jid) {
  const ch = store.chatData.find(c => c.chatJid === jid);
  const name = ch?.chatName || jid;
  $('#confirm-delete-msg').textContent = `All ${(ch?.messageCount || 0).toLocaleString()} messages and summaries for "${name}" will be permanently deleted.`;
  store._pendingDeleteJid = jid;
  $('#confirm-delete').classList.add('open');
}

export function initMenus() {
  $('#btn-chat-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
    syncFetchOlderMenuItem();
    syncIndexChatMenuItem();
    $('#chat-menu').classList.toggle('open');
  });

  $('#menu-index-chat')?.addEventListener('click', () => {
    closeChatMenu();
    if (!store.activeChat) return;
    const ch = store.chatData.find((c) => c.chatJid === store.activeChat);
    if (!ch || !(ch.messageCount > 0)) return;
    void setChatIndexEnabled(store.activeChat, !ch.indexOptedIn);
  });

  $('#menu-fetch-older-history')?.addEventListener('click', async () => {
    closeChatMenu();
    if (!store.activeChat) return;
    if (!activeChatHasLocalMessages()) {
      alert(FETCH_OLDER_NEEDS_ANCHOR
        + '\n\nWhatsApp can only send history older than a message you already have, so there '
        + 'is no starting point for a chat that is still empty. To pull in past conversations, '
        + 'export the chat from your phone and import the file instead.');
      return;
    }
    try {
      const r = await fetch('/api/wa/fetch-older-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ chatJid: store.activeChat, count: 50 }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Request failed');
      alert(
        'Older messages requested from your phone. Keep WhatsApp on your phone online — new batches may arrive over the next minute. '
        + 'If nothing appears, WhatsApp may have reached the limit for this chat; use chat export for a full backup.',
      );
    } catch (e) {
      alert(e.message || 'Could not request older messages');
    }
  });

  document.addEventListener('click', closeSidebarContextMenu);

  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.chat-item')) closeSidebarContextMenu();
  });

  $('#ctx-open-chat').addEventListener('click', () => {
    if (store._ctxMenuJid) openChat(store._ctxMenuJid);
    closeSidebarContextMenu();
  });

  $('#ctx-delete-chat').addEventListener('click', () => {
    const jid = store._ctxMenuJid;
    closeSidebarContextMenu();
    if (!jid) return;
    promptDeleteChat(jid);
  });

  $('#menu-delete-chat').addEventListener('click', () => {
    closeChatMenu();
    if (!store.activeChat) return;
    promptDeleteChat(store.activeChat);
  });

  $('#confirm-delete-no').addEventListener('click', () => {
    $('#confirm-delete').classList.remove('open');
    store._pendingDeleteJid = null;
  });

  $('#confirm-delete-yes').addEventListener('click', async () => {
    $('#confirm-delete').classList.remove('open');
    const jid = store._pendingDeleteJid;
    store._pendingDeleteJid = null;
    if (!jid) return;
    try {
      const res = await fetch(`/api/chats/${encodeURIComponent(jid)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        if (store.activeChat === jid) { store.activeChat = null; switchPanel(); }
        refreshDash();
      }
    } catch (err) {
      console.error('Delete failed:', err);
    }
  });
}

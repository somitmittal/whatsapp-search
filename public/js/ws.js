import { store } from './store.js';
import { applyChatAvatar } from './avatars.js';
import { loadActionItemsForChat, refreshOpenChatMessages } from './chat-view.js';
import { applyMessageReceipt, applyUnreadUpdates, handleSummaryProgress, mergeSyncChatsPreview, refreshDash } from './dashboard.js';
import { loadExpenseRuns } from './expenses.js';
import { syncIndexChatMenuItem } from './menus.js';
import { applyIncomingReactionToDom, applyMessageDeletedToDom, applyMessageEditedToDom, applyMessageRevokedToDom } from './messages-render.js';
import { renderChatsFromState, scheduleRefreshDash } from './sidebar.js';
import { $ } from './util.js';
import { showQr, updateSyncProgress, updateWaUI } from './wa-connection.js';

// ── WebSocket ──────────────────────────────────────────────────────
function connectWS() {
  const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host;
  store.ws = new WebSocket(wsUrl);
  store.ws.onmessage = e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'status') { store.connected = msg.data.connected; refreshDash(); }
      else if (msg.type === 'session-switched') {
        // Server rebound this session to a different tenant (WhatsApp identity restore).
        window.location.reload();
      }
      else if (msg.type === 'new-messages') {
        scheduleRefreshDash(msg.data?.chatTouches);
        void refreshOpenChatMessages();
        if (store._waState === 'READY') { /* keep welcome hidden */ }
      }
      else if (msg.type === 'chat-action-items' && msg.data?.chatJid === store.activeChat) {
        void loadActionItemsForChat(store.activeChat);
        void refreshOpenChatMessages();
      }
      else if (msg.type === 'expense-reconciliation' && $('#overlay-expenses')?.classList.contains('open')) {
        void loadExpenseRuns();
      }
      else if (msg.type === 'chat-names-refreshed') { refreshDash(); }
      else if (msg.type === 'index-toggle' && msg.data?.chatJid) {
        const ch = store.chatData.find((c) => c.chatJid === msg.data.chatJid);
        if (ch) ch.indexOptedIn = !!msg.data.enabled;
        renderChatsFromState();
        syncIndexChatMenuItem();
        void refreshDash();
      }
      else if (msg.type === 'wa-status') {
        const st = msg.data?.state;
        const ignoreForImportFirst = store._importFirstMvp && !store._showLiveSyncUi
          && (st === 'QR_READY' || st === 'LOADING');
        if (ignoreForImportFirst) {
          if (msg.data?.stats) void refreshDash();
          return;
        }
        // Load chat list from SQLite *before* routing UI — reconnect shows saved history instantly (no wait for phone sync).
        if (msg.data.stats) {
          void refreshDash().then(() => {
            updateWaUI(msg.data);
            if (msg.data.state === 'READY') clearInterval(store._qrPollTimer);
          });
        } else {
          updateWaUI(msg.data);
          if (msg.data.state === 'READY') clearInterval(store._qrPollTimer);
        }
      }
      else if (msg.type === 'wa-qr') {
        if (!(store._importFirstMvp && !store._showLiveSyncUi)) showQr(msg.data.qr);
      }
      else if (msg.type === 'sync-chats-preview') { mergeSyncChatsPreview(msg.data?.chats); }
      else if (msg.type === 'chat-avatar') { applyChatAvatar(msg.data); }
      else if (msg.type === 'message-receipt') { applyMessageReceipt(msg.data); }
      else if (msg.type === 'wa-unread') { applyUnreadUpdates(msg.data?.updates); }
      else if (msg.type === 'sync-progress') { updateSyncProgress(msg.data); }
      else if (msg.type === 'summary-progress') { handleSummaryProgress(msg.data); }
      else if (msg.type === 'message-reaction' && msg.data) { applyIncomingReactionToDom(msg.data); }
      else if (msg.type === 'message-revoked' && msg.data) { applyMessageRevokedToDom(msg.data); }
      else if (msg.type === 'message-deleted' && msg.data) { applyMessageDeletedToDom(msg.data); }
      else if (msg.type === 'message-edited' && msg.data) { applyMessageEditedToDom(msg.data); }
      else if (msg.type === 'message-media-ready' && msg.data?.chatJid === store.activeChat) {
        void refreshOpenChatMessages();
      }
    } catch {}
  };
  store.ws.onclose = () => { setTimeout(() => { connectWS(); }, 3000); };
}

export function initWs() {
  connectWS();

  setInterval(async () => {
    try {
      const st = await fetch('/api/status', { credentials: 'same-origin' }).then((r) => r.ok ? r.json() : null);
      const n = Number(st?.stats?.totalMessages) || 0;
      if (n && n !== store._lastSeenMsgCount) {
        const grew = n > store._lastSeenMsgCount && store._lastSeenMsgCount > 0;
        store._lastSeenMsgCount = n;
        if (grew) {
          void refreshDash();
          void refreshOpenChatMessages();
        }
      } else if (n) {
        store._lastSeenMsgCount = n;
      }
    } catch { /* */ }
  }, 6000);
}

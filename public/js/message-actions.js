import { store } from './store.js';
import { sidebarAvatarLetter } from './avatars.js';
import { applyMessageDeletedToDom, applyMessageRevokedToDom } from './messages-render.js';
import { closeOverlay, openOverlay } from './overlays.js';
import { scheduleRefreshDash } from './sidebar.js';
import { $, esc, escAttr } from './util.js';

export function promptDeleteMessage({ chatJid, messageId, fromMe }) {
  store._pendingDeleteMsg = { chatJid, messageId, fromMe: !!fromMe };
  const everyoneBtn = $('#confirm-del-msg-everyone');
  const live = (store._waState === 'READY' || store._waState === 'SYNCING')
    && chatJid && !String(chatJid).endsWith('@imported')
    && !String(chatJid).endsWith('@broadcast');
  const showEveryone = !!fromMe && live;
  if (everyoneBtn) everyoneBtn.style.display = showEveryone ? '' : 'none';
  const msg = $('#confirm-delete-message-msg');
  if (msg) {
    msg.textContent = showEveryone
      ? 'Delete this message only on this device, or for everyone in the chat (WhatsApp time limits apply).'
      : 'This removes the message from your local archive' + (live ? ' and clears it on the linked WhatsApp account when possible.' : '.');
  }
  $('#confirm-delete-message')?.classList.add('open');
}

async function runDeleteMessage(scope) {
  const pending = store._pendingDeleteMsg;
  store._pendingDeleteMsg = null;
  $('#confirm-delete-message')?.classList.remove('open');
  if (!pending?.chatJid || !pending?.messageId) return;
  try {
    const r = await fetch('/api/wa/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatJid: pending.chatJid,
        messageId: pending.messageId,
        scope,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || 'Delete failed');
    if (scope === 'everyone') {
      applyMessageRevokedToDom({ chatJid: pending.chatJid, messageId: pending.messageId });
    } else {
      applyMessageDeletedToDom({ chatJid: pending.chatJid, messageId: pending.messageId });
    }
  } catch (err) {
    alert(err.message || 'Delete failed');
  }
}

function forwardableChats() {
  const out = [];
  const seen = new Set();
  for (const c of store.chatData || []) {
    const jid = c?.chatJid;
    if (!jid || seen.has(jid)) continue;
    if (jid.endsWith('@imported') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter') || jid.endsWith('@bot')) continue;
    if (jid === 'status@broadcast') continue;
    seen.add(jid);
    out.push({ chatJid: jid, chatName: c.chatName || jid });
  }
  out.sort((a, b) => String(a.chatName).localeCompare(String(b.chatName), undefined, { sensitivity: 'base' }));
  return out;
}

export function openForwardOverlay({ chatJid, messageId, preview }) {
  if (store._waState !== 'READY' && store._waState !== 'SYNCING') {
    alert('Link WhatsApp first to forward messages.');
    return;
  }
  store.forwardTarget = { chatJid, messageId, preview: String(preview || '').slice(0, 160) };
  store.forwardSelected = new Set();
  const sub = $('#forward-preview-sub');
  if (sub) sub.textContent = store.forwardTarget.preview
    ? `Forwarding: ${store.forwardTarget.preview}`
    : 'Select chats to forward to';
  const filter = $('#forward-filter');
  if (filter) filter.value = '';
  openOverlay('forward');
  renderForwardChats('');
  const sendBtn = $('#forward-send');
  if (sendBtn) sendBtn.disabled = true;
}

function renderForwardChats(query) {
  const list = $('#forward-chats');
  if (!list) return;
  const q = String(query || '').trim().toLowerCase();
  const rows = forwardableChats().filter((c) => {
    if (store.forwardTarget?.chatJid && c.chatJid === store.forwardTarget.chatJid) return false;
    if (!q) return true;
    return `${c.chatName || ''} ${c.chatJid || ''}`.toLowerCase().includes(q);
  });
  if (!rows.length) {
    list.innerHTML = `<div class="new-msg-empty">${q ? 'No matches.' : 'No chats available to forward to.'}</div>`;
    return;
  }
  list.innerHTML = rows.slice(0, 300).map((c) => {
    const name = c.chatName || c.chatJid;
    const letter = sidebarAvatarLetter(name);
    const sel = store.forwardSelected.has(c.chatJid) ? ' selected' : '';
    return `<button type="button" class="fwd-chat${sel}" data-jid="${escAttr(c.chatJid)}" role="listitem">
        <span class="fwd-chat-avatar">${esc(letter)}</span>
        <span class="fwd-chat-name">${esc(name)}</span>
        <span class="fwd-check" aria-hidden="true"></span>
      </button>`;
  }).join('');
  list.querySelectorAll('.fwd-chat').forEach((btn) => {
    btn.addEventListener('click', () => {
      const jid = btn.dataset.jid;
      if (!jid) return;
      if (store.forwardSelected.has(jid)) store.forwardSelected.delete(jid);
      else {
        if (store.forwardSelected.size >= 20) {
          alert('You can forward to at most 20 chats at once.');
          return;
        }
        store.forwardSelected.add(jid);
      }
      btn.classList.toggle('selected', store.forwardSelected.has(jid));
      const sendBtn = $('#forward-send');
      if (sendBtn) sendBtn.disabled = store.forwardSelected.size === 0;
    });
  });
}

export function initMessageActions() {
  $('#confirm-del-msg-cancel')?.addEventListener('click', () => {
    store._pendingDeleteMsg = null;
    $('#confirm-delete-message')?.classList.remove('open');
  });

  $('#confirm-del-msg-me')?.addEventListener('click', () => void runDeleteMessage('me'));
  $('#confirm-del-msg-everyone')?.addEventListener('click', () => void runDeleteMessage('everyone'));
  $('#forward-filter')?.addEventListener('input', (e) => renderForwardChats(e.target.value));

  $('#forward-send')?.addEventListener('click', async () => {
    if (!store.forwardTarget?.messageId || !store.forwardSelected.size) return;
    const btn = $('#forward-send');
    if (btn) btn.disabled = true;
    try {
      const r = await fetch('/api/wa/forward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatJid: store.forwardTarget.chatJid,
          messageId: store.forwardTarget.messageId,
          targetJids: [...store.forwardSelected],
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || 'Forward failed');
      const n = j.forwarded || store.forwardSelected.size;
      closeOverlay('forward');
      store.forwardTarget = null;
      store.forwardSelected.clear();
      scheduleRefreshDash([...((j.results || []).filter((x) => x.ok).map((x) => ({
        chatJid: x.targetJid,
        lastMessageTs: Math.floor(Date.now() / 1000),
        count: 1,
      })))]);
      alert(n === 1 ? 'Message forwarded.' : `Message forwarded to ${n} chats.`);
    } catch (err) {
      alert(err.message || 'Forward failed');
      if (btn) btn.disabled = store.forwardSelected.size === 0;
    }
  });
}

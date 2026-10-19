import { store } from './store.js';
import { refreshActiveChatMessages } from './chat-view.js';
import { applyMessageEditedToDom } from './messages-render.js';
import { scheduleRefreshDash } from './sidebar.js';
import { $ } from './util.js';
import { wantsLiveSyncUi } from './wa-connection.js';

export function shouldHideComposerForJid(jid) {
  if (!jid) return true;
  return jid === 'status@broadcast' || jid.endsWith('@broadcast')
    || jid.endsWith('@newsletter') || jid.endsWith('@bot')
    || jid.endsWith('@imported');
}

export function canSendMessageToJid(jid) {
  return (store._waState === 'READY' || store._waState === 'SYNCING') && !shouldHideComposerForJid(jid);
}

export function updateComposerVisibility() {
  const composer = document.getElementById('chat-composer');
  const canSend = canSendMessageToJid(store.activeChat);
  if (composer) composer.style.display = canSend ? '' : 'none';
  if (!canSend) { clearReplyTarget(); clearEditTarget(); }
  const newMsgBtn = document.getElementById('btn-new-message');
  if (newMsgBtn) {
    const show = wantsLiveSyncUi() && (store._waState === 'READY' || store._waState === 'SYNCING');
    newMsgBtn.style.display = show ? '' : 'none';
  }
}

export function clearReplyTarget() {
  store.replyTarget = null;
  const bar = $('#reply-to-bar');
  if (bar) bar.style.display = 'none';
  const prev = $('#reply-to-preview');
  if (prev) prev.textContent = '';
}

export function clearEditTarget() {
  store.editTarget = null;
  const bar = $('#edit-to-bar');
  if (bar) bar.style.display = 'none';
  const prev = $('#edit-to-preview');
  if (prev) prev.textContent = '';
  const btn = document.getElementById('msg-send');
  if (btn) btn.textContent = 'Send';
  const input = document.getElementById('msg-text');
  if (input) input.placeholder = 'Type a message…';
}

export function setReplyTarget(messageId, preview) {
  clearEditTarget();
  store.replyTarget = { messageId: String(messageId || ''), preview: String(preview || '').slice(0, 200) };
  const bar = $('#reply-to-bar');
  const prev = $('#reply-to-preview');
  if (prev) prev.textContent = store.replyTarget.preview || '(message)';
  if (bar) bar.style.display = '';
  document.getElementById('msg-text')?.focus?.();
}

export function setEditTarget(messageId, preview) {
  clearReplyTarget();
  store.editTarget = { messageId: String(messageId || ''), preview: String(preview || '').slice(0, 200) };
  const bar = $('#edit-to-bar');
  const prev = $('#edit-to-preview');
  if (prev) prev.textContent = store.editTarget.preview || '(message)';
  if (bar) bar.style.display = '';
  const btn = document.getElementById('msg-send');
  if (btn) btn.textContent = 'Save';
  const input = document.getElementById('msg-text');
  if (input) {
    input.placeholder = 'Edit message…';
    input.value = String(preview || '');
    input.focus?.();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* */ }
  }
}

function refreshActiveChatAfterSend(jid, delayMs) {
  setTimeout(() => {
    if (store.activeChat !== jid) return;
    if (typeof store.onActiveChatRefresh === 'function') void store.onActiveChatRefresh();
    else void refreshActiveChatMessages();
  }, delayMs);
}

export async function sendCurrentMessage() {
  const jid = store.activeChat;
  const input = document.getElementById('msg-text');
  const fileInput = document.getElementById('msg-file-input');
  const file = fileInput?.files?.[0];
  const btn = document.getElementById('msg-send');
  if (!jid || !input || !btn) return;
  const text = String(input.value || '').trim();
  if (!text && !file) return;
  if (file && store.editTarget?.messageId) { alert('Remove the attachment before editing a message'); return; }
  btn.disabled = true;
  try {
    if (file) {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('chatJid', jid);
      if (text) form.append('caption', text);
      const r = await fetch('/api/wa/send-file', { method: 'POST', body: form });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || 'File send failed');
      fileInput.value = '';
      input.value = '';
      input.placeholder = 'Type a message…';
      clearReplyTarget();
      scheduleRefreshDash([{ chatJid: jid, lastMessageTs: Math.floor(Date.now() / 1000), count: 1 }]);
      refreshActiveChatAfterSend(jid, 1200);
      return;
    }
    if (store.editTarget?.messageId) {
      const mid = store.editTarget.messageId;
      const r = await fetch('/api/wa/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatJid: jid, messageId: mid, text }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || 'Edit failed');
      input.value = '';
      clearEditTarget();
      applyMessageEditedToDom({ chatJid: jid, messageId: mid, text });
      refreshActiveChatAfterSend(jid, 600);
      return;
    }
    const payload = { chatJid: jid, text };
    if (store.replyTarget?.messageId) payload.quotedMessageId = store.replyTarget.messageId;
    const r = await fetch('/api/wa/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || 'Send failed');
    input.value = '';
    clearReplyTarget();
    scheduleRefreshDash([{ chatJid: jid, lastMessageTs: Math.floor(Date.now() / 1000), count: 1 }]);
    // The sent message will appear via WA echo + indexing; refresh as a fallback.
    refreshActiveChatAfterSend(jid, 1200);
  } catch (e) {
    alert(e.message || 'Send failed');
  } finally {
    btn.disabled = false;
  }
}

export function initComposer() {
  document.getElementById('msg-send')?.addEventListener('click', sendCurrentMessage);

  const fileInput = document.getElementById('msg-file-input');
  document.getElementById('msg-attach')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    const input = document.getElementById('msg-text');
    if (input) input.placeholder = file ? `Caption for ${file.name}` : 'Type a message…';
  });

  const chatPanel = document.getElementById('panel-chat');
  let dragDepth = 0;
  chatPanel?.addEventListener('dragenter', (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    dragDepth += 1;
    chatPanel.classList.add('file-drop-active');
  });
  chatPanel?.addEventListener('dragover', (e) => {
    if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }
  });
  chatPanel?.addEventListener('dragleave', (e) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) chatPanel.classList.remove('file-drop-active');
  });
  chatPanel?.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    chatPanel.classList.remove('file-drop-active');
    if (!canSendMessageToJid(store.activeChat)) {
      alert('Select a WhatsApp chat to attach a file.');
      return;
    }
    const transfer = new DataTransfer();
    transfer.items.add(e.dataTransfer.files[0]);
    if (fileInput) {
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  document.getElementById('msg-text')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendCurrentMessage(); }
  });

  $('#reply-to-clear')?.addEventListener('click', clearReplyTarget);

  $('#edit-to-clear')?.addEventListener('click', () => {
    clearEditTarget();
    const input = document.getElementById('msg-text');
    if (input) input.value = '';
  });
}

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

async function uploadFileToChat(file, jid, caption = '') {
  showFileSendProgress(`Uploading ${file.name}…`, 0);
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('chatJid', jid);
  if (caption) form.append('caption', caption);
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/wa/send-file');
    xhr.timeout = 5 * 60 * 1000;
    xhr.upload.addEventListener('progress', (event) => {
      const percent = event.lengthComputable && event.total > 0
        ? Math.min(100, Math.round((event.loaded / event.total) * 100))
        : null;
      showFileSendProgress(percent == null
        ? `Uploading ${file.name}…`
        : `Uploading ${file.name} · ${percent}%`, percent);
      if (percent === 100) showFileSendProgress(`Uploaded ${file.name} · sending to WhatsApp…`, 100);
    });
    xhr.addEventListener('load', () => {
      let result = {};
      try { result = JSON.parse(xhr.responseText || '{}'); } catch { /* handled below */ }
      if (xhr.status < 200 || xhr.status >= 300) reject(new Error(result?.error || `File send failed (${xhr.status})`));
      else resolve();
    });
    xhr.addEventListener('error', () => reject(new Error('Network error while uploading file')));
    xhr.addEventListener('timeout', () => reject(new Error('File upload timed out')));
    xhr.send(form);
  });
}

function showFileSendProgress(message, percent = null) {
  const root = document.getElementById('file-send-progress');
  if (!root) return;
  root.hidden = false;
  const status = root.querySelector('.file-send-status');
  if (status) status.textContent = message;
  const meter = root.querySelector('.file-send-meter');
  if (meter) {
    meter.value = percent == null ? 0 : percent;
    meter.toggleAttribute('data-indeterminate', percent == null);
  }
}

function hideFileSendProgress() {
  const root = document.getElementById('file-send-progress');
  if (root) root.hidden = true;
}

function updateAttachmentPreview(fileInput) {
  const preview = document.getElementById('msg-attachment-preview');
  if (!preview) return;
  const files = Array.from(fileInput?.files || []);
  const image = preview.querySelector('img');
  const label = preview.querySelector('.file-attachment-name');
  const file = files[0];
  if (preview.dataset.previewUrl) URL.revokeObjectURL(preview.dataset.previewUrl);
  preview.dataset.previewUrl = '';
  if (!file) {
    if (image) { image.hidden = true; image.removeAttribute('src'); }
    if (label) label.textContent = '';
    preview.hidden = true;
    return;
  }
  if (label) label.textContent = files.length > 1 ? `${file.name} + ${files.length - 1} more` : file.name;
  if (image && file.type.startsWith('image/')) {
    preview.dataset.previewUrl = URL.createObjectURL(file);
    image.src = preview.dataset.previewUrl;
    image.hidden = false;
  } else if (image) {
    image.hidden = true;
    image.removeAttribute('src');
  }
  preview.hidden = false;
}

export async function sendCurrentMessage() {
  const jid = store.activeChat;
  const input = document.getElementById('msg-text');
  const fileInput = document.getElementById('msg-file-input');
  const files = Array.from(fileInput?.files || []);
  const btn = document.getElementById('msg-send');
  if (!jid || !input || !btn) return;
  const text = String(input.value || '').trim();
  if (!text && !files.length) return;
  if (files.length && store.editTarget?.messageId) { alert('Remove the attachment before editing a message'); return; }
  btn.disabled = true;
  try {
    if (files.length) {
      for (let i = 0; i < files.length; i += 1) {
        await uploadFileToChat(files[i], jid, i === 0 ? text : '');
      }
      fileInput.value = '';
      updateAttachmentPreview(fileInput);
      input.value = '';
      input.placeholder = 'Type a message…';
      showFileSendProgress(files.length === 1 ? 'File sent' : `${files.length} files sent`, 100);
      clearReplyTarget();
      scheduleRefreshDash(files.map(() => ({ chatJid: jid, lastMessageTs: Math.floor(Date.now() / 1000), count: 1 })));
      refreshActiveChatAfterSend(jid, 1200);
      setTimeout(hideFileSendProgress, 2500);
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
    if (document.getElementById('file-send-progress') && !document.getElementById('file-send-progress').hidden) {
      showFileSendProgress(`Could not send file: ${e.message || 'unknown error'}`, null);
    }
    alert(e.message || 'Send failed');
  } finally {
    btn.disabled = false;
  }
}

export function initComposer() {
  document.getElementById('msg-send')?.addEventListener('click', sendCurrentMessage);

  const fileInput = document.getElementById('msg-file-input');
  if (fileInput) fileInput.multiple = true;
  document.getElementById('msg-attach')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => {
    updateAttachmentPreview(fileInput);
    const file = fileInput.files?.[0];
    const input = document.getElementById('msg-text');
    if (input) input.placeholder = fileInput.files.length > 1
      ? `Caption for ${fileInput.files.length} files`
      : file ? `Caption for ${file.name}` : 'Type a message…';
  });
  document.getElementById('msg-attachment-remove')?.addEventListener('click', () => {
    if (fileInput) fileInput.value = '';
    updateAttachmentPreview(fileInput);
    const input = document.getElementById('msg-text');
    if (input) input.placeholder = 'Type a message…';
  });

  const dropTargets = [
    document.getElementById('panel-chat'),
    document.getElementById('gpt-wa-view'),
    document.getElementById('gpt-wa-composer'),
  ].filter(Boolean);
  let dragDepth = 0;
  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  for (const target of dropTargets) target.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth += 1;
    target.classList.add('file-drop-active');
  });
  for (const target of dropTargets) target.addEventListener('dragover', (e) => {
    if (isFileDrag(e)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }
  });
  for (const target of dropTargets) target.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) for (const dropTarget of dropTargets) dropTarget.classList.remove('file-drop-active');
  });
  for (const target of dropTargets) target.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    for (const dropTarget of dropTargets) dropTarget.classList.remove('file-drop-active');
    if (!canSendMessageToJid(store.activeChat)) {
      alert('Select a WhatsApp chat to attach a file.');
      return;
    }
    if (!fileInput) return;
    fileInput.files = e.dataTransfer.files;
    updateAttachmentPreview(fileInput);
    const captionInput = document.getElementById('msg-text');
    if (captionInput) {
      captionInput.placeholder = fileInput.files.length > 1
        ? `Caption for ${fileInput.files.length} files`
        : `Caption for ${fileInput.files[0].name}`;
      captionInput.focus();
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

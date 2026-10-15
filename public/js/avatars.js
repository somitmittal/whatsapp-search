import { store } from './store.js';
import { displayChatTitle } from './format.js';
import { $, esc, escAttr } from './util.js';

export function avatarLetterFor(jid, title, participantCount) {
  const isGroup = String(jid || '').includes('@g.us') || (Number(participantCount) > 2);
  const n = String(title || '');
  return isGroup
    ? (n.trim().charAt(0) + (n.trim().charAt(1) || '')).toUpperCase()
    : sidebarAvatarLetter(n);
}

function chatAvatarUrl(jid, avatarRev) {
  return `/api/chats/${encodeURIComponent(jid)}/avatar?v=${encodeURIComponent(String(avatarRev || 0))}`;
}

export function chatAvatarHtml(jid, letter, hasAvatar, avatarRev) {
  const photo = hasAvatar
    ? `<img class="chat-avatar-img" alt="" loading="lazy" decoding="async" src="${escAttr(chatAvatarUrl(jid, avatarRev))}" onerror="this.closest('.chat-avatar')?.classList.remove('has-photo'); this.remove()">`
    : '';
  return `${photo}<span class="chat-avatar-letter">${esc(letter)}</span>`;
}

export function paintAvatarEl(el, jid, title, participantCount, hasAvatar, avatarRev) {
  if (!el) return;
  const letter = avatarLetterFor(jid, title, participantCount);
  el.innerHTML = chatAvatarHtml(jid, letter, !!hasAvatar, avatarRev);
  el.classList.toggle('has-photo', !!hasAvatar);
  el.dataset.avatarJid = jid || '';
  el.dataset.avatarTitle = title || '';
  el.dataset.avatarRev = String(avatarRev || 0);
  el.title = hasAvatar ? 'View photo' : '';
  el.setAttribute('role', hasAvatar ? 'button' : 'presentation');
  if (hasAvatar) el.setAttribute('tabindex', '0');
  else el.removeAttribute('tabindex');
}

export function openAvatarViewer(jid, title, avatarRev) {
  if (!jid) return;
  const ov = $('#avatar-viewer');
  const img = $('#avatar-viewer-img');
  const name = $('#avatar-viewer-title');
  if (!ov || !img) return;
  if (name) name.textContent = title || displayChatTitle(jid, jid);
  img.src = chatAvatarUrl(jid, avatarRev);
  img.alt = name?.textContent || 'Profile photo';
  ov.hidden = false;
  ov.classList.add('open');
  ov.setAttribute('aria-hidden', 'false');
}

export function closeAvatarViewer() {
  const ov = $('#avatar-viewer');
  const img = $('#avatar-viewer-img');
  if (!ov) return;
  ov.classList.remove('open');
  ov.hidden = true;
  ov.setAttribute('aria-hidden', 'true');
  if (img) img.removeAttribute('src');
}

function avatarElFromEventTarget(target) {
  const el = target?.closest?.('.chat-avatar');
  if (!el || !el.classList.contains('has-photo')) return null;
  return el;
}

export function applyChatAvatar(data) {
  const jid = data?.chatJid;
  if (!jid) return;
  const row = (store.chatData || []).find((c) => c.chatJid === jid);
  if (row) {
    row.hasAvatar = !!data.hasAvatar;
    row.avatarRev = data.avatarRev || 0;
  }
  const title = displayChatTitle(jid, row?.chatName || jid);
  document.querySelectorAll('.chat-item').forEach((item) => {
    if (item.dataset.jid !== jid) return;
    paintAvatarEl(item.querySelector('.chat-avatar'), jid, title, row?.participantCount, data.hasAvatar, data.avatarRev);
  });
  if (store.activeChat === jid) {
    paintAvatarEl($('#cv-avatar'), jid, title, row?.participantCount, data.hasAvatar, data.avatarRev);
  }
}

export function sidebarAvatarLetter(displayTitle) {
  const t = String(displayTitle || '');
  const d = /\d/.exec(t);
  return (d ? d[0] : (t.charAt(0) || '?')).toUpperCase();
}

export function initAvatars() {
  $('#avatar-viewer-close')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeAvatarViewer();
  });

  $('#avatar-viewer')?.addEventListener('click', (e) => {
    if (e.target?.id === 'avatar-viewer' || e.target?.classList?.contains('avatar-viewer-stage')) {
      closeAvatarViewer();
    }
  });

  $('#cv-avatar')?.addEventListener('click', (e) => {
    const av = avatarElFromEventTarget(e.target) || (e.currentTarget?.classList?.contains('has-photo') ? e.currentTarget : null);
    if (!av) return;
    e.preventDefault();
    e.stopPropagation();
    openAvatarViewer(av.dataset.avatarJid, av.dataset.avatarTitle, av.dataset.avatarRev);
  });

  $('#cv-avatar')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const av = e.currentTarget;
    if (!av?.classList?.contains('has-photo')) return;
    e.preventDefault();
    openAvatarViewer(av.dataset.avatarJid, av.dataset.avatarTitle, av.dataset.avatarRev);
  });
}

import { store } from './store.js';
import { sidebarAvatarLetter } from './avatars.js';
import { openChat } from './chat-view.js';
import { updateComposerVisibility } from './composer.js';
import { displayChatTitle, formatPhoneLikeName } from './format.js';
import { closeOverlay, openOverlay } from './overlays.js';
import { setSidebarListTab } from './sidebar.js';
import { $, esc, escAttr } from './util.js';

async function ensureWaContactsCache() {
  if (store._waContactsCache.length) return store._waContactsCache;
  const data = await fetch('/api/wa/contacts').then((r) => r.json());
  store._waContactsCache = Array.isArray(data?.contacts) ? data.contacts : [];
  const fromChats = (store.chatData || [])
    .filter((c) => c?.chatJid && !c.chatJid.includes('@g.us') && !c.chatJid.endsWith('@imported')
      && !c.chatJid.endsWith('@broadcast') && !c.chatJid.endsWith('@newsletter'))
    .map((c) => ({
      chatJid: c.chatJid,
      chatName: displayChatTitle(c.chatJid, c.chatName || c.chatJid),
      phone: null,
    }));
  const byJid = new Map();
  for (const row of [...store._waContactsCache, ...fromChats]) {
    if (!row?.chatJid || byJid.has(row.chatJid)) continue;
    byJid.set(row.chatJid, row);
  }
  store._waContactsCache = [...byJid.values()].sort((a, b) =>
    String(a.chatName || '').localeCompare(String(b.chatName || ''), undefined, { sensitivity: 'base' }),
  );
  return store._waContactsCache;
}

export async function openNewMessageOverlay() {
  if (store._waState !== 'READY' && store._waState !== 'SYNCING') {
    alert('Link WhatsApp first to send messages.');
    return;
  }
  openOverlay('new-message');
  const status = $('#new-msg-status');
  const list = $('#new-msg-contacts');
  const filter = $('#new-msg-filter');
  if (status) status.textContent = 'Loading contacts…';
  if (list) list.innerHTML = '<div class="new-msg-empty">Loading…</div>';
  if (filter) filter.value = '';
  try {
    await ensureWaContactsCache();
    if (status) {
      status.textContent = store._waContactsCache.length
        ? `${store._waContactsCache.length} contact${store._waContactsCache.length === 1 ? '' : 's'} from WhatsApp`
        : 'No named contacts yet — enter a phone number with country code.';
    }
    renderNewMessageContacts('');
  } catch (e) {
    if (status) status.textContent = e.message || 'Could not load contacts';
    if (list) list.innerHTML = '<div class="new-msg-empty">Could not load contacts.</div>';
  }
}

export async function openNewGroupOverlay() {
  if (store._waState !== 'READY' && store._waState !== 'SYNCING') {
    alert('Link WhatsApp first to create a group.');
    return;
  }
  store._newGroupSelected = new Map();
  closeOverlay('new-message');
  openOverlay('new-group');
  const subject = $('#new-group-subject');
  const filter = $('#new-group-filter');
  const status = $('#new-group-status');
  const list = $('#new-group-contacts');
  if (subject) subject.value = '';
  if (filter) filter.value = '';
  if (status) status.textContent = 'Loading contacts…';
  if (list) list.innerHTML = '<div class="new-msg-empty">Loading…</div>';
  renderNewGroupSelected();
  updateNewGroupCreateEnabled();
  try {
    await ensureWaContactsCache();
    if (status) {
      status.textContent = store._waContactsCache.length
        ? 'Tap contacts to add them, then name the group.'
        : 'No contacts loaded yet. Open New chat and message someone first, or enter their number.';
    }
    renderNewGroupContacts('');
  } catch (e) {
    if (status) status.textContent = e.message || 'Could not load contacts';
    if (list) list.innerHTML = '<div class="new-msg-empty">Could not load contacts.</div>';
  }
}

function renderNewGroupSelected() {
  const box = $('#new-group-selected');
  const sub = $('#new-group-sub');
  if (!box) return;
  const rows = [...store._newGroupSelected.values()];
  if (sub) {
    sub.textContent = rows.length
      ? `${rows.length} participant${rows.length === 1 ? '' : 's'} selected`
      : 'Add participants';
  }
  box.innerHTML = rows.map((c) => {
    const name = c.chatName || c.chatJid;
    const letter = sidebarAvatarLetter(name);
    return `<span class="new-group-chip" data-jid="${escAttr(c.chatJid)}">
        <span class="new-group-chip-av">${esc(letter)}</span>
        ${esc(name)}
        <button type="button" data-remove-jid="${escAttr(c.chatJid)}" aria-label="Remove ${escAttr(name)}">×</button>
      </span>`;
  }).join('');
  box.querySelectorAll('[data-remove-jid]').forEach((btn) => {
    btn.addEventListener('click', () => {
      store._newGroupSelected.delete(btn.getAttribute('data-remove-jid'));
      renderNewGroupSelected();
      renderNewGroupContacts($('#new-group-filter')?.value || '');
      updateNewGroupCreateEnabled();
    });
  });
}

function updateNewGroupCreateEnabled() {
  const btn = $('#new-group-create');
  const subject = String($('#new-group-subject')?.value || '').trim();
  if (btn) btn.disabled = !(subject && store._newGroupSelected.size);
}

function renderNewGroupContacts(query) {
  const list = $('#new-group-contacts');
  if (!list) return;
  const q = String(query || '').trim().toLowerCase();
  const rows = (store._waContactsCache || []).filter((c) => {
    if (!q) return true;
    return `${c.chatName || ''} ${c.phone || ''} ${c.chatJid || ''}`.toLowerCase().includes(q);
  });
  if (!rows.length) {
    list.innerHTML = `<div class="new-msg-empty">${q ? 'No matches.' : 'No WhatsApp contacts loaded yet.'}</div>`;
    return;
  }
  list.innerHTML = rows.slice(0, 300).map((c) => {
    const name = c.chatName || c.chatJid;
    const letter = sidebarAvatarLetter(name);
    const sub = c.phone || (c.chatJid?.endsWith('@s.whatsapp.net') ? formatPhoneLikeName(c.chatJid) : '');
    const sel = store._newGroupSelected.has(c.chatJid) ? ' selected' : '';
    return `<button type="button" class="fwd-chat${sel}" data-jid="${escAttr(c.chatJid)}" data-name="${escAttr(name)}" role="listitem">
        <span class="fwd-chat-avatar">${esc(letter)}</span>
        <span class="fwd-chat-name">${esc(name)}${sub ? `<br><span style="font-weight:400;color:var(--text2);font-size:12px">${esc(sub)}</span>` : ''}</span>
        <span class="fwd-check" aria-hidden="true"></span>
      </button>`;
  }).join('');
  list.querySelectorAll('.fwd-chat').forEach((btn) => {
    btn.addEventListener('click', () => {
      const jid = btn.dataset.jid;
      if (!jid) return;
      if (store._newGroupSelected.has(jid)) store._newGroupSelected.delete(jid);
      else {
        store._newGroupSelected.set(jid, {
          chatJid: jid,
          chatName: btn.dataset.name || jid,
          phone: null,
        });
      }
      renderNewGroupSelected();
      renderNewGroupContacts($('#new-group-filter')?.value || '');
      updateNewGroupCreateEnabled();
    });
  });
}

function renderNewMessageContacts(query) {
  const list = $('#new-msg-contacts');
  if (!list) return;
  const q = String(query || '').trim().toLowerCase();
  const rows = !store._waContactsCache.length
    ? []
    : store._waContactsCache.filter((c) => {
      if (!q) return true;
      const blob = `${c.chatName || ''} ${c.phone || ''} ${c.chatJid || ''}`.toLowerCase();
      return blob.includes(q);
    });
  if (!rows.length) {
    list.innerHTML = `<div class="new-msg-empty">${q ? 'No matches.' : 'No WhatsApp contacts loaded yet. Enter a phone number above.'}</div>`;
    return;
  }
  list.innerHTML = rows.slice(0, 200).map((c) => {
    const name = c.chatName || c.chatJid;
    const letter = sidebarAvatarLetter(name);
    const sub = c.phone || (c.chatJid?.endsWith('@s.whatsapp.net') ? formatPhoneLikeName(c.chatJid) : '');
    return `<button type="button" class="new-msg-contact" data-jid="${escAttr(c.chatJid)}" data-name="${escAttr(name)}" role="listitem">
        <span class="new-msg-contact-avatar">${esc(letter)}</span>
        <span class="new-msg-contact-meta">
          <span class="new-msg-contact-name">${esc(name)}</span>
          ${sub ? `<span class="new-msg-contact-phone">${esc(sub)}</span>` : ''}
        </span>
      </button>`;
  }).join('');
  list.querySelectorAll('.new-msg-contact').forEach((btn) => {
    btn.addEventListener('click', () => {
      void startChatWithContact(btn.dataset.jid, btn.dataset.name);
    });
  });
}

async function startChatWithContact(chatJid, chatName) {
  const status = $('#new-msg-status');
  if (!chatJid) return;
  if (status) status.textContent = 'Opening chat…';
  try {
    const r = await fetch('/api/wa/start-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatJid, chatName }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Could not open chat');
    const jid = data.chatJid || chatJid;
    const name = data.chatName || chatName || jid;
    // Ensure the chat appears in the WhatsApp tab immediately.
    if (!store.chatData.find((c) => c.chatJid === jid)) {
      store.chatData.unshift({
        chatJid: jid,
        chatName: name,
        messageCount: 0,
        participantCount: 1,
        lastMessageTs: Math.floor(Date.now() / 1000),
        sidebarTab: 'chat',
        unreadCount: 0,
      });
    } else {
      const row = store.chatData.find((c) => c.chatJid === jid);
      if (row && name) row.chatName = name;
    }
    setSidebarListTab('chat', { pin: false });
    closeOverlay('new-message');
    await openChat(jid);
    updateComposerVisibility();
    const input = document.getElementById('msg-text');
    if (input) input.focus();
  } catch (e) {
    if (status) status.textContent = e.message || 'Failed';
    else alert(e.message || 'Failed');
  }
}

async function startChatWithPhone() {
  const phoneEl = $('#new-msg-phone');
  const status = $('#new-msg-status');
  const phone = String(phoneEl?.value || '').trim();
  if (!phone) {
    if (status) status.textContent = 'Enter a phone number with country code.';
    return;
  }
  if (status) status.textContent = 'Checking WhatsApp…';
  try {
    const r = await fetch('/api/wa/start-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Number not on WhatsApp');
    await startChatWithContact(data.chatJid, data.chatName);
  } catch (e) {
    if (status) status.textContent = e.message || 'Failed';
  }
}

export function initContacts() {
  $('#new-msg-filter')?.addEventListener('input', (e) => renderNewMessageContacts(e.target.value));
  $('#new-msg-phone-go')?.addEventListener('click', () => void startChatWithPhone());

  $('#new-msg-phone')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void startChatWithPhone();
    }
  });

  $('#new-group-filter')?.addEventListener('input', (e) => renderNewGroupContacts(e.target.value));
  $('#new-group-subject')?.addEventListener('input', () => updateNewGroupCreateEnabled());

  $('#new-group-create')?.addEventListener('click', async () => {
    const btn = $('#new-group-create');
    const status = $('#new-group-status');
    const subject = String($('#new-group-subject')?.value || '').trim();
    const participantJids = [...store._newGroupSelected.keys()];
    if (!subject || !participantJids.length) return;
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Creating group…';
    try {
      const r = await fetch('/api/wa/create-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, participantJids }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Could not create group');
      const jid = data.chatJid;
      const name = data.chatName || subject;
      if (!store.chatData.find((c) => c.chatJid === jid)) {
        store.chatData.unshift({
          chatJid: jid,
          chatName: name,
          messageCount: 0,
          participantCount: data.participantCount || participantJids.length + 1,
          lastMessageTs: Math.floor(Date.now() / 1000),
          sidebarTab: 'chat',
          unreadCount: 0,
        });
      } else {
        const row = store.chatData.find((c) => c.chatJid === jid);
        if (row) row.chatName = name;
      }
      setSidebarListTab('chat', { pin: false });
      closeOverlay('new-group');
      store._newGroupSelected = new Map();
      await openChat(jid);
      updateComposerVisibility();
      const input = document.getElementById('msg-text');
      if (input) input.focus();
    } catch (e) {
      if (status) status.textContent = e.message || 'Failed';
      else alert(e.message || 'Failed');
      updateNewGroupCreateEnabled();
    }
  });
}

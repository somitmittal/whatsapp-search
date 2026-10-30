import { store } from './store.js';
import { paintAvatarEl } from './avatars.js';
import { hideAwaySummaryBar, loadAwaySummaryForChat } from './away-summary.js';
import { canSendMessageToJid, clearEditTarget, clearReplyTarget, setEditTarget, setReplyTarget, shouldHideComposerForJid, updateComposerVisibility } from './composer.js';
import { CHAT_PAGE, INITIAL_CHAT_MESSAGES_LIMIT } from './constants.js';
import { displayChatTitle, formatChatBubbleDateTime, formatDate, isResolvedChatName, messageTimestampToDate } from './format.js';
import { mediaDownloadUrl } from './media.js';
import { activeChatHasLocalMessages } from './menus.js';
import { openForwardOverlay, promptDeleteMessage } from './message-actions.js';
import { buildChatMessagesHtml, closeReactionEmojiPickers, mediaIndexStateHtml, postWaReaction, renderMessages, toggleMessageMenu, toggleReactionEmojiPicker } from './messages-render.js';
import { closeAllOverlays, setMobileChatOpen, switchPanel } from './overlays.js';
import { clearSearch, openSearchAssistant } from './search.js';
import { renderChatsFromState, setSidebarListTab, sidebarTabOf } from './sidebar.js';
import { $, $$, esc, escAttr } from './util.js';

// ── Open chat ──────────────────────────────────────────────────────
/** Technical chat metadata (JID, owner, participant counts) stays hidden — name is enough. */
function renderCvContact(_d, _jid) {
  const el = $('#cv-contact');
  if (!el) return;
  el.classList.remove('visible');
  el.innerHTML = '';
}

function fileBaseHint(path) {
  if (!path) return '';
  const s = String(path).replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function chatInfoRow(label, value) {
  if (value == null || value === '') return '';
  return `<div class="chat-info-row"><span class="chat-info-label">${esc(label)}</span><div class="chat-info-value">${esc(String(value))}</div></div>`;
}

async function openChatInfo() {
  const jid = store.activeChat;
  if (!jid) return;
  const overlay = $('#chat-info-overlay');
  const content = $('#chat-info-content');
  const title = $('#chat-info-title');
  const subtitle = $('#chat-info-subtitle');
  if (!overlay || !content) return;
  overlay.classList.add('open');
  content.textContent = 'Loading details…';
  title.textContent = displayChatTitle(jid, store.chatData.find((c) => c.chatJid === jid)?.chatName || jid);
  subtitle.textContent = 'Chat information';
  try {
    const response = await fetch(`/api/wa/chat-details?chatJid=${encodeURIComponent(jid)}`);
    const details = response.ok ? await response.json() : null;
    if (store.activeChat !== jid || !overlay.classList.contains('open')) return;
    if (!details) throw new Error('Chat details are unavailable.');
    const chatName = details.subject || details.chatName || details.displayName || title.textContent;
    title.textContent = displayChatTitle(jid, chatName);
    subtitle.textContent = details.isGroup ? 'Group chat' : (details.isImported ? 'Imported chat' : 'Direct chat');
    const rows = [];
    if (details.isGroup) {
      if (Number(details.participantCount) > 0) {
        rows.push(chatInfoRow('Members', `${details.participantCount} members`));
      } else if (Number(details.participantCountFromDb) > 0) {
        rows.push(chatInfoRow('Participants seen in messages', details.participantCountFromDb));
      } else {
        rows.push(chatInfoRow('Members', details.waConnected ? 'Unavailable' : 'Connect WhatsApp to load the live member count'));
      }
      rows.push(chatInfoRow('Description', details.description || 'No group description'));
    } else if (details.phone) {
      rows.push(chatInfoRow('Phone', `+${details.phone}`));
    }
    rows.push(chatInfoRow('Messages stored', Number(details.messageCount) || 0));
    if (details.lastMessageTs) {
      rows.push(chatInfoRow('Last message', new Date(details.lastMessageTs * 1000).toLocaleString()));
    }
    if (!details.isImported) {
      rows.push(chatInfoRow('WhatsApp connection', details.waConnected ? 'Connected' : 'Offline — showing saved information'));
    }
    content.innerHTML = rows.filter(Boolean).join('') || '<div class="chat-info-row">No additional details are available.</div>';
  } catch (error) {
    if (store.activeChat === jid && overlay.classList.contains('open')) {
      content.textContent = error.message || 'Could not load chat details.';
    }
  }
}

function closeChatInfo() {
  $('#chat-info-overlay')?.classList.remove('open');
}

async function fetchChatAttachments(jid) {
  try {
    const r = await fetch(`/api/chats/${encodeURIComponent(jid)}/attachments`);
    if (!r.ok) return;
    store.attachmentsPayload = await r.json();
    if (store.activeChat === jid && store.cvTab !== 'chat') renderCvAttachmentsPanel();
  } catch {
    store.attachmentsPayload = null;
  }
}

function renderCvAttachmentsPanel() {
  const box = $('#cv-attachments');
  if (!box || !store.attachmentsPayload) return;
  const tab = store.cvTab;
  const media = store.attachmentsPayload.media || [];
  const docs = store.attachmentsPayload.docs || [];
  const links = store.attachmentsPayload.links || [];
  let html = '';
  if (tab === 'media') {
    if (!media.length) {
      html = '<div class="attach-empty">No photos, videos, or voice notes in this chat yet.</div>';
    } else {
      html = '<div class="attach-grid">' + media.map((row) => {
        const mid = escAttr(row.messageId || '');
        const u = row.messageId ? `/api/message-media?messageId=${encodeURIComponent(row.messageId)}` : '';
        const mt = row.mediaType || '';
        const dd = messageTimestampToDate(row.timestamp);
        const attWhen = dd ? esc(formatChatBubbleDateTime(dd)) : '';
        let inner = '';
        if (mt === 'audio') {
          inner = `<div class="attach-card-audio">Voice message</div><audio class="status-slide-audio" src="${escAttr(u)}" controls></audio>`;
        } else if (mt === 'video') {
          inner = `<video class="status-slide-vid" src="${escAttr(u)}" controls playsinline></video>`;
        } else {
          inner = `<img class="status-slide-img" src="${escAttr(u)}" alt="">`;
        }
        const du = row.messageId ? mediaDownloadUrl(row.messageId) : '';
        const state = mediaIndexStateHtml(row);
        return `<div class="attach-card">${inner}${attWhen ? `<div class="attach-card-meta">${attWhen}</div>` : ''}${state ? `<div class="attach-card-meta">${state}</div>` : ''}<div class="attach-card-actions">${du ? `<a class="attach-dl" href="${escAttr(du)}" download>Download</a>` : ''}<button type="button" class="attach-open-msg" data-mid="${mid}">Show in chat</button></div></div>`;
      }).join('') + '</div>';
    }
  } else if (tab === 'links') {
    if (!links.length) html = '<div class="attach-empty">No links detected in message text.</div>';
    else {
      html = '<div class="attach-list">' + links.map((L) => `
          <div class="attach-row">
            <a href="${escAttr(L.url)}" target="_blank" rel="noopener noreferrer">${esc(L.url)}</a>
            <div class="attach-meta">${esc(L.snippet || '')}</div>
            <div class="attach-row-actions"><button type="button" class="attach-open-msg" data-mid="${escAttr(L.messageId)}">Show in chat</button></div>
          </div>`).join('') + '</div>';
    }
  } else if (tab === 'docs') {
    if (!docs.length) html = '<div class="attach-empty">No documents in this chat yet. PDF text is indexed for search after the file is downloaded.</div>';
    else {
      html = '<div class="attach-list">' + docs.map((row) => {
        const name = esc(row.mediaCaption || fileBaseHint(row.mediaPath) || 'Document');
        const mid = escAttr(row.messageId || '');
        const u = row.messageId ? `/api/message-media?messageId=${encodeURIComponent(row.messageId)}` : '';
        const dl = row.messageId ? mediaDownloadUrl(row.messageId) : '';
        const open = u ? ` · <a href="${escAttr(u)}" target="_blank" rel="noopener">Open file</a>` : '';
        const dlLink = dl ? ` · <a class="attach-dl" href="${escAttr(dl)}" download>Download</a>` : '';
        return `<div class="attach-row"><strong>${name}</strong><div class="attach-meta">${formatDate(row.timestamp)}${open}${dlLink}</div><div class="attach-row-actions"><button type="button" class="attach-open-msg" data-mid="${mid}">Show in chat</button></div></div>`;
      }).join('') + '</div>';
    }
  }
  box.innerHTML = html;
}

function setCvTab(tab) {
  store.cvTab = tab;
  const tabsRoot = $('#cv-tabs');
  if (tabsRoot) {
    tabsRoot.querySelectorAll('.cv-tab').forEach((b) => {
      const on = b.getAttribute('data-cv-tab') === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  const msg = $('#cv-messages');
  const att = $('#cv-attachments');
  if (tab === 'chat') {
    if (msg) msg.style.display = '';
    if (att) att.hidden = true;
  } else {
    if (msg) msg.style.display = 'none';
    if (att) att.hidden = false;
    renderCvAttachmentsPanel();
  }
}

export async function openChat(jid, focusMessageId = null) {
  closeChatInfo();
  clearReplyTarget();
  clearEditTarget();
  store.activeChat = jid;
  store.cvTab = 'chat';
  store.attachmentsPayload = null;
  const tabsEl = $('#cv-tabs');
  if (tabsEl) {
    tabsEl.style.display = 'flex';
    tabsEl.querySelectorAll('.cv-tab').forEach((b) => {
      const on = b.getAttribute('data-cv-tab') === 'chat';
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  const cvMsg = $('#cv-messages');
  const cvAtt = $('#cv-attachments');
  if (cvMsg) cvMsg.style.display = '';
  if (cvAtt) { cvAtt.hidden = true; cvAtt.innerHTML = ''; }
  closeAllOverlays();
  if (focusMessageId) {
    store.searchActive = false;
    $('#panel-search').classList.remove('visible');
    store.activeFocusMessageId = focusMessageId;
  } else {
    clearSearch();
    store.activeFocusMessageId = null;
    store.chatMessagesOffset = 0;
    store.chatHasMoreLocal = true;
    store.chatLoadingOlder = false;
    store.chatOldestAnchorTs = null;
    store.chatPhoneFetchAttempted = false;
  }
  const ch = store.chatData.find(c => c.chatJid === jid);
  // Follow the chat into its tab, but don't treat that as the user choosing a tab —
  // linking WhatsApp later should still be able to surface the live list.
  if (ch && sidebarTabOf(ch) !== store.sidebarListTab) setSidebarListTab(sidebarTabOf(ch), { pin: false });
  const n = displayChatTitle(jid, ch?.chatName || jid);
  $('#cv-name').textContent = n;
  // Keep the subtitle empty — no participant / message-count metadata in the header.
  const infoEl = $('#cv-info');
  if (infoEl) infoEl.textContent = '';
  paintAvatarEl($('#cv-avatar'), jid, n, ch?.participantCount, ch?.hasAvatar, ch?.avatarRev);
  renderCvContact(null, jid);
  $$('.chat-item').forEach(i => i.classList.toggle('active', i.dataset.jid === jid));
  switchPanel();
  updateComposerVisibility();
  const aiChatBtn = document.getElementById('btn-chat-ai-search');
  if (aiChatBtn) {
    const hideAi = !jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')
      || jid.endsWith('@newsletter') || jid.endsWith('@bot');
    aiChatBtn.style.display = hideAi ? 'none' : 'flex';
  }
  try {
    const msgUrl = focusMessageId
      ? `/api/messages?chatJid=${encodeURIComponent(jid)}&limit=8000&focusMessageId=${encodeURIComponent(focusMessageId)}`
      : `/api/messages?chatJid=${encodeURIComponent(jid)}&limit=${INITIAL_CHAT_MESSAGES_LIMIT}&offset=0`;
    const [msgsRes, details] = await Promise.all([
      fetch(msgUrl).then(async r => {
        if (!r.ok) { console.error('[openChat] messages API error:', r.status); return []; }
        const data = await r.json();
        return Array.isArray(data) ? data : [];
      }),
      fetch(`/api/wa/chat-details?chatJid=${encodeURIComponent(jid)}`).then(r => r.ok ? r.json() : null),
    ]);
    const msgs = msgsRes;
    if (store.activeChat !== jid) return;
    renderMessages(msgs, jid, focusMessageId);
    if (!focusMessageId && msgs.length) {
      const sorted = [...msgs].sort((a, b) => {
        const ta = messageTimestampToDate(a.timestamp)?.getTime() ?? 0;
        const tb = messageTimestampToDate(b.timestamp)?.getTime() ?? 0;
        return ta - tb;
      });
      store.chatOldestAnchorTs = sorted[0].timestamp;
      store.chatMessagesOffset = msgs.length;
      const chRow = store.chatData.find((c) => c.chatJid === jid);
      const loaded = msgs.length;
      if (typeof chRow?.messageCount === 'number') {
        store.chatHasMoreLocal = loaded < chRow.messageCount;
      } else {
        store.chatHasMoreLocal = loaded >= INITIAL_CHAT_MESSAGES_LIMIT;
      }
    }
    if (details && store.activeChat === jid) {
      // Prefer an already-resolved sidebar/header title over WA placeholders so imported
      // chats never flip from "Sovrenn Family…" to "import" after chat-details returns.
      const incomingRaw = details.subject || details.chatName || details.displayName || '';
      const keepExisting = isResolvedChatName(jid, ch?.chatName) && !isResolvedChatName(jid, incomingRaw);
      const displayRaw = keepExisting ? (ch?.chatName || n) : (incomingRaw || n);
      const display = displayChatTitle(jid, displayRaw);
      $('#cv-name').textContent = display;
      paintAvatarEl($('#cv-avatar'), jid, display, ch?.participantCount, ch?.hasAvatar, ch?.avatarRev);
      const row = store.chatData.find(c => c.chatJid === jid);
      if (row && display && isResolvedChatName(jid, display)) row.chatName = display;
      renderChatsFromState();
      renderCvContact(null, jid);
    }
    void loadActionItemsForChat(jid);
    // Snapshot sidebar unread when present; server also counts messages since the
    // catch-up dismiss cursor so the panel still appears after mark-seen.
    const unreadSnap = Math.max(0, Number(ch?.unreadCount) || 0);
    const openSnapshot = unreadSnap > 10
      ? { unreadCount: unreadSnap, sinceTs: 0, lastThreadsDone: 0 }
      : null;
    await loadAwaySummaryForChat(jid, openSnapshot);
    void fetchChatAttachments(jid);
    fetch('/api/summaries/priority-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ chatJid: jid }),
    }).catch(() => {});
  } catch (err) {
    console.error('[openChat]', err);
  }
  // Mark seen only after the unread-summary request captured its window.
  fetch(`/api/chats/${encodeURIComponent(jid)}/seen`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  // Clear local unread badge immediately so the list matches "opened".
  const openedRow = store.chatData.find((c) => c.chatJid === jid);
  if (openedRow && openedRow.unreadCount) {
    openedRow.unreadCount = 0;
    renderChatsFromState();
  }
  setMobileChatOpen(true);
}

async function loadOlderChatPage() {
  const jid = store.activeChat;
  if (!jid || store.chatLoadingOlder || store.activeFocusMessageId) return;
  if (!store.chatHasMoreLocal) {
    // Without a stored message there is no cursor for on-demand sync, so skip the call.
    if (!store.chatPhoneFetchAttempted && activeChatHasLocalMessages()) {
      store.chatPhoneFetchAttempted = true;
      try {
        await fetch('/api/wa/fetch-older-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ chatJid: jid, count: 50 }),
        });
      } catch { /* optional phone sync */ }
    }
    return;
  }
  store.chatLoadingOlder = true;
  try {
    const rows = await fetch(
      `/api/messages?chatJid=${encodeURIComponent(jid)}&limit=${CHAT_PAGE}&offset=${store.chatMessagesOffset}`,
    ).then((r) => r.json());
    if (store.activeChat !== jid) return;
    if (!rows.length) {
      store.chatHasMoreLocal = false;
      return;
    }
    const sortedAsc = [...rows].sort((a, b) => {
      const ta = messageTimestampToDate(a.timestamp)?.getTime() ?? 0;
      const tb = messageTimestampToDate(b.timestamp)?.getTime() ?? 0;
      return ta - tb;
    });
    const c = $('#cv-messages');
    const oldH = c.scrollHeight;
    const oldTop = c.scrollTop;
    const frag = buildChatMessagesHtml(sortedAsc, jid, null, store.chatOldestAnchorTs);
    c.insertAdjacentHTML('afterbegin', frag);
    c.scrollTop = c.scrollHeight - oldH + oldTop;
    store.chatMessagesOffset += rows.length;
    store.chatOldestAnchorTs = sortedAsc[0]?.timestamp ?? store.chatOldestAnchorTs;
    if (rows.length < CHAT_PAGE) store.chatHasMoreLocal = false;
    const ch = store.chatData.find((x) => x.chatJid === jid);
    if (ch && typeof ch.messageCount === 'number' && store.chatMessagesOffset >= ch.messageCount) {
      store.chatHasMoreLocal = false;
    }
  } catch { /* ignore */ } finally {
    store.chatLoadingOlder = false;
  }
}

/**
 * Reload the open chat transcript. GPT shell paints `#gpt-wa-view` via
 * `store.onActiveChatRefresh`; classic UI uses `#cv-messages`.
 */
export function refreshOpenChatMessages() {
  if (typeof store.onActiveChatRefresh === 'function') return store.onActiveChatRefresh();
  return refreshActiveChatMessages();
}

export async function refreshActiveChatMessages() {
  const jid = store.activeChat;
  if (!jid) return;
  if (store.activeFocusMessageId) {
    try {
      const msgs = await fetch(
        `/api/messages?chatJid=${encodeURIComponent(jid)}&limit=8000&focusMessageId=${encodeURIComponent(store.activeFocusMessageId)}`,
      ).then((r) => r.json());
      if (store.activeChat !== jid) return;
      renderMessages(msgs, jid, store.activeFocusMessageId);
    } catch {}
    return;
  }
  try {
    const lim = Math.max(store.chatMessagesOffset || INITIAL_CHAT_MESSAGES_LIMIT, INITIAL_CHAT_MESSAGES_LIMIT);
    const msgs = await fetch(`/api/messages?chatJid=${encodeURIComponent(jid)}&limit=${lim}&offset=0`).then((r) => r.json());
    if (store.activeChat !== jid) return;
    renderMessages(msgs, jid);
    const sorted = [...msgs].sort((a, b) => {
      const ta = messageTimestampToDate(a.timestamp)?.getTime() ?? 0;
      const tb = messageTimestampToDate(b.timestamp)?.getTime() ?? 0;
      return ta - tb;
    });
    if (sorted.length) {
      store.chatOldestAnchorTs = sorted[0].timestamp;
      store.chatMessagesOffset = sorted.length;
      const ch = store.chatData.find((x) => x.chatJid === jid);
      if (typeof ch?.messageCount === 'number') {
        store.chatHasMoreLocal = store.chatMessagesOffset < ch.messageCount;
      } else {
        store.chatHasMoreLocal = sorted.length >= INITIAL_CHAT_MESSAGES_LIMIT;
      }
    } else {
      store.chatOldestAnchorTs = null;
      store.chatMessagesOffset = 0;
      store.chatHasMoreLocal = false;
    }
  } catch {}
}

export async function loadActionItemsForChat(jid) {
  const wrap = $('#chat-action-items-bar');
  const body = $('#action-items-body');
  const sum = $('#action-items-summary');
  const det = $('#action-items-details');
  if (!wrap || !body) return;
  if (!jid) {
    wrap.style.display = 'none';
    return;
  }
  try {
    const rows = await fetch(`/api/chats/${encodeURIComponent(jid)}/action-items`).then((r) => r.json());
    if (store.activeChat !== jid) return;
    if (!rows || !rows.length) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = '';
    const total = rows.reduce((n, r) => n + ((r.items && r.items.length) || 0), 0);
    if (sum) sum.textContent = `Suggested follow-ups (${total})`;
    body.innerHTML = rows.map((r) => {
      const when = r.messageTimestamp
        ? (messageTimestampToDate(r.messageTimestamp)?.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) || 'Unknown date')
        : '';
      const snip = (r.snippet || '').trim() || '(message)';
      const items = (r.items || []).map((t) => `<li>${esc(String(t))}</li>`).join('');
      return `<div class="ai-group">
          <div class="ai-group-title">${when ? esc(when) + ' — ' : ''}${esc(snip)}</div>
          <ul>${items}</ul>
          <span class="ai-jump" data-mid="${escAttr(r.sourceMessageId)}">Jump to message</span>
        </div>`;
    }).join('');
    body.querySelectorAll('.ai-jump').forEach((el) => {
      el.addEventListener('click', () => {
        const mid = el.getAttribute('data-mid');
        if (mid && store.activeChat) void openChat(store.activeChat, mid);
      });
    });
    if (det) det.open = true;
  } catch {
    wrap.style.display = 'none';
  }
}

export function initChatView() {
    const infoTrigger = $('#cv-info-trigger');
    infoTrigger?.addEventListener('click', () => { void openChatInfo(); });
    infoTrigger?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      void openChatInfo();
    });
    $('#chat-info-close')?.addEventListener('click', closeChatInfo);
    $('#chat-info-overlay')?.addEventListener('click', (event) => {
      if (event.target?.id === 'chat-info-overlay') closeChatInfo();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeChatInfo();
    });

    $('#cv-tabs')?.querySelectorAll('.cv-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-cv-tab');
        if (tab) setCvTab(tab);
      });
    });

    $('#cv-attachments')?.addEventListener('click', (e) => {
      const t = e.target?.closest?.('.attach-open-msg');
      if (!t || !t.dataset?.mid) return;
      e.preventDefault();
      const jid = store.activeChat;
      if (!jid) return;
      void openChat(jid, t.dataset.mid);
    });

    $('#btn-mobile-chat-back').addEventListener('click', () => {
    clearReplyTarget();
    clearEditTarget();
    store.activeChat = null;
    store.activeFocusMessageId = null;
    store.cvTab = 'chat';
    store.attachmentsPayload = null;
    const te = $('#cv-tabs');
    if (te) te.style.display = 'none';
    const cvAtt = $('#cv-attachments');
    if (cvAtt) { cvAtt.hidden = true; cvAtt.innerHTML = ''; }
    store.searchActive = false;
    $('#panel-search').classList.remove('visible');
    const aibar = $('#chat-action-items-bar');
    if (aibar) aibar.style.display = 'none';
    hideAwaySummaryBar();
    const composer = document.getElementById('chat-composer');
    if (composer) composer.style.display = 'none';
    const aiChatBtnBack = document.getElementById('btn-chat-ai-search');
    if (aiChatBtnBack) aiChatBtnBack.style.display = 'none';
    $$('.chat-item').forEach(i => i.classList.remove('active'));
    setMobileChatOpen(false);
    switchPanel();
  });

  $('#cv-messages')?.addEventListener('scroll', () => {
    if (!store.activeChat || store.activeFocusMessageId || store.chatLoadingOlder || !store.chatHasMoreLocal) return;
    const el = $('#cv-messages');
    if (el.scrollTop > 100) {
      store.cvOlderScrollArmed = true;
      return;
    }
    if (!store.cvOlderScrollArmed) return;
    store.cvOlderScrollArmed = false;
    void loadOlderChatPage().finally(() => {
      setTimeout(() => { store.cvOlderScrollArmed = true; }, 400);
    });
  }, { passive: true });

  $('#cv-messages')?.addEventListener('click', async (e) => {
    const mediaRetry = e.target.closest('[data-wa-media-retry]');
    if (mediaRetry) {
      e.stopPropagation();
      if (!store.activeChat || mediaRetry.disabled) return;
      mediaRetry.disabled = true;
      mediaRetry.textContent = 'Retrying…';
      try {
        // menus.js imports this module, so load it lazily to keep the cycle out of eval order.
        const { priorityLoadChat } = await import('./menus.js');
        await priorityLoadChat(store.activeChat, { alertResult: false });
      } catch (err) {
        mediaRetry.disabled = false;
        mediaRetry.textContent = 'Retry';
        alert(err.message || 'Could not retry this download');
      }
      return;
    }
    const menuBtn = e.target.closest('[data-wa-menu-toggle]');
    if (menuBtn) {
      e.stopPropagation();
      toggleMessageMenu(menuBtn);
      return;
    }
    const aiBtn = e.target.closest('[data-wa-ai-search]');
    if (aiBtn) {
      const block = e.target.closest('.msg-block');
      if (!block?.dataset?.messageId) return;
      e.stopPropagation();
      const pr = (aiBtn.getAttribute('data-ai-preview') || '').trim();
      const seed = pr
        ? `About this message: ${pr.slice(0, 550)}${pr.length > 550 ? '…' : ''}`
        : 'Summarize the conversation around this message.';
      await openSearchAssistant({ showThreads: true, seedQuery: seed, runSeed: true });
      return;
    }
    const rep = e.target.closest('[data-wa-reply]');
    if (rep) {
      const block = e.target.closest('.msg-block');
      if (!block?.dataset?.messageId) return;
      e.stopPropagation();
      const pr = rep.getAttribute('data-reply-preview') || '';
      setReplyTarget(block.dataset.messageId, pr, {
        sender: rep.getAttribute('data-sender') || '',
        fromMe: block.dataset.fromMe === '1',
        mediaType: rep.getAttribute('data-media-type') || '',
        thumb: rep.getAttribute('data-media-thumb') || '',
      });
      return;
    }
    const reactEl = e.target.closest('[data-wa-react]');
    if (reactEl) {
      const block = e.target.closest('.msg-block');
      if (!block?.dataset?.messageId) return;
      e.stopPropagation();
      closeReactionEmojiPickers();
      try {
        await postWaReaction(block.dataset.storageJid || store.activeChat, block.dataset.messageId, reactEl.getAttribute('data-wa-react') ?? '👍');
      } catch (err) {
        alert(err.message || 'Reaction failed');
      }
      return;
    }
    const emojiPickerToggle = e.target.closest('[data-wa-emoji-picker-toggle]');
    if (emojiPickerToggle) {
      e.stopPropagation();
      toggleReactionEmojiPicker(emojiPickerToggle);
      return;
    }
    const fwd = e.target.closest('[data-wa-forward]');
    if (fwd) {
      const block = e.target.closest('.msg-block');
      if (!block?.dataset?.messageId) return;
      e.stopPropagation();
      openForwardOverlay({
        chatJid: block.dataset.storageJid || store.activeChat,
        messageId: block.dataset.messageId,
        preview: fwd.getAttribute('data-forward-preview') || '',
      });
      return;
    }
    const editBtn = e.target.closest('[data-wa-edit]');
    if (editBtn) {
      const block = e.target.closest('.msg-block');
      if (!block?.dataset?.messageId) return;
      e.stopPropagation();
      if (!canSendMessageToJid(store.activeChat)) {
        alert('Link WhatsApp to edit messages.');
        return;
      }
      setEditTarget(block.dataset.messageId, editBtn.getAttribute('data-edit-preview') || '');
      return;
    }
    const delBtn = e.target.closest('[data-wa-delete]');
    if (delBtn) {
      const block = e.target.closest('.msg-block');
      if (!block?.dataset?.messageId) return;
      e.stopPropagation();
      promptDeleteMessage({
        chatJid: block.dataset.storageJid || store.activeChat,
        messageId: block.dataset.messageId,
        fromMe: delBtn.getAttribute('data-from-me') === '1' || block.dataset.fromMe === '1',
      });
    }
  });
}

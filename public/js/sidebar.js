import { store } from './store.js';
import { avatarLetterFor, chatAvatarHtml, openAvatarViewer } from './avatars.js';
import { applySmbUi, loadBusinessInbox } from './business.js';
import { openChat } from './chat-view.js';
import { applyChatSummaryBars, applySearchIndexBars, refreshDash, setChatIndexEnabled } from './dashboard.js';
import { displayChatTitle, formatCount, formatDate, formatPhoneLikeName, receiptTicksHtml } from './format.js';
import { showSidebarContextMenu } from './menus.js';
import { renderStatusStrip } from './status-feed.js';
import { $, esc, escAttr } from './util.js';
import { applyWaSyncBars, canShowChatUI, isWaUiReady } from './wa-connection.js';

export function sidebarTabOf(row) {
  if (row?.sidebarTab) return row.sidebarTab;
  const jid = String(row?.chatJid || '');
  if (jid.endsWith('@imported')) return 'imported';
  if (jid.endsWith('@broadcast') || jid.endsWith('@newsletter') || jid.endsWith('@bot')) {
    return 'feed';
  }
  return 'chat';
}

function chatsForCurrentSidebarTab() {
  return store.chatData.filter((row) => sidebarTabOf(row) === store.sidebarListTab);
}

/** Counts on the tab labels, so live chats landing behind the current tab are still visible. */
function renderSidebarTabCounts() {
  const counts = { imported: 0, chat: 0, feed: 0 };
  for (const c of store.chatData) {
    const tab = sidebarTabOf(c);
    if (counts[tab] === undefined) continue;
    counts[tab] += 1;
  }
  document.querySelectorAll('[data-tab-count]').forEach((el) => {
    const n = counts[el.getAttribute('data-tab-count')] || 0;
    el.textContent = n ? String(n) : '';
  });
}

/**
 * Land on a tab that actually has something in it. Imports are the only chats visible
 * while WhatsApp is offline, so an untouched "WhatsApp" default would look like data loss.
 */
export function autoSelectSidebarTab() {
  if (store.sidebarTabPinnedByUser) return;
  if (store.sidebarListTab === 'business') return;
  const hasLive = store.chatData.some((c) => sidebarTabOf(c) === 'chat');
  const hasImported = store.chatData.some((c) => sidebarTabOf(c) === 'imported');
  const wanted = (isWaUiReady() || hasLive) && hasLive
    ? 'chat'
    : (hasImported ? 'imported' : store.sidebarListTab);
  if (wanted !== store.sidebarListTab) setSidebarListTab(wanted, { pin: false });
}

/** Match the phone: newest message first. Volume does not move a chat up. */
export function sortChatDataByRecency() {
  store.chatData.sort((a, b) => {
    const tb = b.lastMessageTs || 0;
    const ta = a.lastMessageTs || 0;
    if (tb !== ta) return tb - ta;
    return (b.messageCount || 0) - (a.messageCount || 0);
  });
}

/**
 * Move one chat to index 0. Does NOT re-sort (sort would undo the splice);
 * the caller should call renderChatsFromState() when ready.
 */
function pinChatToTop(chatJid) {
  if (!chatJid || !Array.isArray(store.chatData) || !store.chatData.length) return;
  const i = store.chatData.findIndex((c) => c.chatJid === chatJid);
  if (i > 0) {
    const [ch] = store.chatData.splice(i, 1);
    store.chatData.unshift(ch);
  }
}

/**
 * Bump chats that received new messages (instant sidebar reorder).
 * @returns {boolean} true if an unknown chat needs full /api/chats refresh
 */
function applyChatTouches(touches) {
  if (!Array.isArray(touches) || !touches.length) return false;
  const known = new Set(store.chatData.map((c) => c.chatJid));
  let needFullRefresh = false;
  for (const t of touches) {
    const jid = t?.chatJid;
    if (!jid) continue;
    if (!known.has(jid)) {
      needFullRefresh = true;
      continue;
    }
    const ch = store.chatData.find((c) => c.chatJid === jid);
    if (!ch) continue;
    const ts = Number(t.lastMessageTs) || 0;
    const delta = Number(t.count) || 0;
    if (ts > 0) ch.lastMessageTs = Math.max(ch.lastMessageTs || 0, ts);
    if (delta > 0) ch.messageCount = (ch.messageCount || 0) + delta;
  }
  sortChatDataByRecency();
  return needFullRefresh;
}

export function scheduleRefreshDash(chatTouches) {
  if (Array.isArray(chatTouches) && chatTouches.length) {
    const needFull = applyChatTouches(chatTouches);
    if (canShowChatUI()) renderChatsFromState();
    if (needFull) {
      clearTimeout(store._refreshDashTimer);
      void refreshDash();
      return;
    }
  }
  clearTimeout(store._refreshDashTimer);
  store._refreshDashTimer = setTimeout(() => { void refreshDash(); }, 400);
}

export function renderChatsFromState() {
  if (!canShowChatUI()) return;
  sortChatDataByRecency();
  const fq = ($('#filter') && $('#filter').value || '').trim().toLowerCase();
  let list = chatsForCurrentSidebarTab();
  renderSidebarTabCounts();
  if (fq) {
    list = list.filter((c) => {
      const jid = String(c.chatJid || '');
      const hay = (c.chatName || c.chatJid).toLowerCase();
      if (hay.includes(fq)) return true;
      if (jid.endsWith('@s.whatsapp.net')) {
        const disp = formatPhoneLikeName(jid).toLowerCase();
        if (disp.includes(fq)) return true;
        const jq = fq.replace(/\D/g, '');
        if (jq.length >= 3 && jid.split('@')[0].includes(jq)) return true;
      }
      return false;
    });
  }
  renderChats(list);
}

const SIDEBAR_TABS = ['imported', 'chat', 'feed', 'business'];

export function setSidebarListTab(tab, { pin = true } = {}) {
  store.sidebarListTab = SIDEBAR_TABS.includes(tab) ? tab : 'imported';
  if (pin) store.sidebarTabPinnedByUser = true;
  document.querySelectorAll('[data-sidebar-tab]').forEach((b) => {
    const on = b.getAttribute('data-sidebar-tab') === store.sidebarListTab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const bizPanel = $('#business-inbox-panel');
  const chatList = $('#chat-list');
  const filterWrap = document.querySelector('.sidebar-search');
  const isBusiness = store.sidebarListTab === 'business';
  if (bizPanel) bizPanel.classList.toggle('visible', isBusiness);
  if (chatList) chatList.style.display = isBusiness ? 'none' : '';
  if (filterWrap) filterWrap.style.display = isBusiness ? 'none' : '';
  const filterInput = $('#filter');
  if (filterInput) {
    filterInput.placeholder = store.sidebarListTab === 'imported'
      ? 'Search imported chats'
      : (store.sidebarListTab === 'feed' ? 'Search status and feeds' : 'Search or start a new chat');
  }
  if (isBusiness) void loadBusinessInbox();
  else renderChatsFromState();
  renderStatusStrip();
  applySmbUi();
}

function sidebarEmptyMessage() {
  const hint = (t) => `<br><span style="opacity:.85;font-size:13px">${t}</span>`;
  if (store.sidebarListTab === 'imported') {
    return `No imported chats yet.${hint('Click <strong>+</strong> to import a WhatsApp export.')}`;
  }
  if (!isWaUiReady()) {
    return `WhatsApp isn\u2019t linked.${hint('Scan the QR code to see your live chats here.')}`;
  }
  if (store.sidebarListTab === 'feed') {
    return `No status or channel entries yet.${hint('They are indexed after WhatsApp sync and appear here.')}`;
  }
  return `No WhatsApp chats synced yet.${hint('They appear here as sync progresses.')}`;
}

function renderChats(chats) {
  const c = $('#chat-list');
  if (!store._chatRowCache) store._chatRowCache = new Map();
  if (!chats.length) {
    store._chatRowCache.clear();
    c.innerHTML = `<div class="sidebar-empty">${sidebarEmptyMessage()}</div>`;
    return;
  }
  const tpl = document.createElement('template');
  const nodes = chats.map((ch) => {
    const html = chatRowHtml(ch);
    const cached = store._chatRowCache.get(ch.chatJid);
    let el = cached && cached.html === html ? cached.el : null;
    if (!el) {
      tpl.innerHTML = html;
      el = tpl.content.firstElementChild;
      store._chatRowCache.set(ch.chatJid, { html, el });
    }
    el.classList.toggle('active', store.activeChat === ch.chatJid);
    return el;
  });
  const wanted = new Set(nodes);
  for (const child of [...c.children]) {
    if (!wanted.has(child)) child.remove();
  }
  let ref = c.firstElementChild;
  for (const el of nodes) {
    if (el === ref) { ref = ref.nextElementSibling; continue; }
    c.insertBefore(el, ref);
  }
  if (store._chatRowCache.size > nodes.length) {
    const keep = new Set(chats.map((ch) => ch.chatJid));
    for (const jid of store._chatRowCache.keys()) if (!keep.has(jid)) store._chatRowCache.delete(jid);
  }
  applyWaSyncBars();
  applySearchIndexBars();
  applyChatSummaryBars();
}

function chatRowHtml(ch) {
    const n = displayChatTitle(ch.chatJid, ch.chatName || ch.chatJid);
    const avatarHtml = chatAvatarHtml(
      ch.chatJid,
      avatarLetterFor(ch.chatJid, n, ch.participantCount),
      ch.hasAvatar,
      ch.avatarRev,
    );
    const pct = ch.searchIndexPct ?? 0;
    const sumT = ch.summarizedThreads ?? 0;
    const totT = ch.totalThreads ?? 0;
    const aiDone = !!ch.aiSearchComplete;
    const aiReady = !!ch.aiSearchReady;
    let badgeClass = '';
    let badgeText = 'AI —';
    if (aiDone) { badgeClass = 'complete'; badgeText = 'AI ✓'; }
    else if (aiReady) { badgeClass = 'partial'; badgeText = pct + '%'; }
    const optedIn = !!ch.indexOptedIn;
    const canToggleAi = ch.messageCount > 0;
    const aiToggleTitle = !canToggleAi
      ? 'Needs messages before AI indexing'
      : (optedIn
        ? 'AI indexing on — click to turn off'
        : 'Index this chat for AI search (off by default)');
    const aiToggle = canToggleAi
      ? `<button type="button" class="chat-ai-toggle${optedIn ? ' on' : ''}" title="${esc(aiToggleTitle)}" aria-pressed="${optedIn ? 'true' : 'false'}" aria-label="${optedIn ? 'Disable AI indexing' : 'Enable AI indexing'}">${optedIn ? 'AI on' : 'AI'}</button>`
      : '';
    const unread = Math.max(0, Number(ch.unreadCount) || 0);
    const unreadBadge = unread > 0
      ? `<span class="chat-count-badge" title="${unread} unread">${esc(formatCount(unread))}</span>`
      : '';
    const previewTicks = ch.lastMessageFromMe
      ? `<span class="chat-preview-ticks">${receiptTicksHtml(ch.lastMessageReceipt)}</span>`
      : '';
    const preview = ch.lastMessagePreview
      ? `<span class="chat-preview-text">${esc(ch.lastMessagePreview)}</span>`
      : '';
    return `<div class="chat-item${unread ? ' unread' : ''}" data-jid="${esc(ch.chatJid)}">
        <div class="chat-avatar${ch.hasAvatar ? ' has-photo' : ''}" data-avatar-jid="${escAttr(ch.chatJid)}" data-avatar-title="${escAttr(n)}" data-avatar-rev="${escAttr(String(ch.avatarRev || 0))}"${ch.hasAvatar ? ' role="button" tabindex="0" title="View photo"' : ''}>${avatarHtml}</div>
        <div class="chat-meta">
          <div class="chat-meta-top">
            <span class="chat-name">${esc(n)}</span>
            <span class="chat-date">${esc(formatDate(ch.lastMessageTs))}</span>
          </div>
          <div class="chat-meta-bottom">
            <span class="chat-preview">${previewTicks}${preview}</span>
            <span class="chat-meta-badges">
              ${aiToggle}
              <span class="search-badge ${badgeClass}" title="Thread summaries for AI search">${esc(badgeText)}</span>
              ${unreadBadge}
            </span>
          </div>
        </div>
        <div class="search-index-track${aiDone ? ' done' : ''}" data-jid="${esc(ch.chatJid)}"
          data-search-pct="${pct}" data-search-complete="${aiDone ? '1' : '0'}"
          data-summarized="${sumT}" data-total-threads="${totT}"
          style="${optedIn && ch.messageCount > 0 ? '' : 'display:none'}"><div class="search-index-bar"></div></div>
        <div class="chat-index-track" data-jid="${esc(ch.chatJid)}" style="display:none"><div class="chat-index-bar"></div></div>
      </div>`;
}

export function initSidebar() {
  // One delegated listener set for the sidebar — rows are reused across renders.
  (function bindChatListEvents() {
    const c = $('#chat-list');
    if (!c) return;
    const openAvatar = (e, av) => {
      e.preventDefault();
      e.stopPropagation();
      openAvatarViewer(av.dataset.avatarJid, av.dataset.avatarTitle, av.dataset.avatarRev);
    };
    c.addEventListener('click', (e) => {
      const toggle = e.target.closest('.chat-ai-toggle');
      if (toggle && c.contains(toggle)) {
        e.preventDefault();
        e.stopPropagation();
        const jid = toggle.closest('.chat-item')?.dataset?.jid;
        if (jid) void setChatIndexEnabled(jid, !toggle.classList.contains('on'));
        return;
      }
      const av = e.target.closest('.chat-avatar.has-photo');
      if (av && c.contains(av)) { openAvatar(e, av); return; }
      const item = e.target.closest('.chat-item');
      if (item && c.contains(item)) openChat(item.dataset.jid);
    });
    c.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const av = e.target.closest('.chat-avatar.has-photo');
      if (av && c.contains(av)) openAvatar(e, av);
    });
    c.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('.chat-item');
      if (item && c.contains(item)) showSidebarContextMenu(e, item.dataset.jid);
    });
  })();

  $('#filter').addEventListener('input', () => {
    renderChatsFromState();
  });

  document.querySelectorAll('[data-sidebar-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setSidebarListTab(btn.getAttribute('data-sidebar-tab')));
  });
}

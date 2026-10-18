import { initBusiness } from '/js/business.js';
import { chatRowHtml } from '/js/chat-row.js';
import {
    canSendMessageToJid,
    clearEditTarget,
    clearReplyTarget,
    initComposer,
    setEditTarget,
    setReplyTarget,
    updateComposerVisibility,
} from '/js/composer.js';
import { INITIAL_CHAT_MESSAGES_LIMIT } from '/js/constants.js';
import { renderExpenseDiff } from '/js/expense-sheet-view.js';
import { initExpenses } from '/js/expenses.js';
import { initFetchShim } from '/js/fetch-shim.js';
import { displayChatTitle } from '/js/format.js';
import { initGmail } from '/js/gmail.js';
import { initImport } from '/js/import.js';
import { initMessageActions, promptDeleteMessage } from '/js/message-actions.js';
import { buildChatMessagesHtml, postWaReaction } from '/js/messages-render.js';
import { initOverlays, openOverlay, setSettingsTab } from '/js/overlays.js';
import { initSettings, loadSettings } from '/js/settings.js';
import { autoSelectSidebarTab, renderSidebarTabCounts, setSidebarListTab, sidebarTabOf } from '/js/sidebar.js';
import { store } from '/js/store.js';
import { esc, escAttr } from '/js/util.js';
import { initWaBootstrap } from '/js/wa-bootstrap.js';
import { isWaUiReady, updateWaUI } from '/js/wa-connection.js';

initFetchShim();
initComposer();
initMessageActions();
initOverlays();
initSettings();
initBusiness();
initExpenses();
initGmail();
initImport();
initWaBootstrap();

const $ = (sel) => document.querySelector(sel);
const els = {
  app: $('#gpt-app'),
  tabs: $('#gpt-tabs'),
  tabMenu: $('#gpt-tab-menu'),
  threads: $('#gpt-threads'),
  filter: $('#gpt-thread-filter'),
  threadSearch: $('#gpt-thread-search'),
  threadSearchBtn: $('#gpt-thread-search-btn'),
  settings: $('#gpt-settings'),
  settingsBtn: $('#gpt-settings-btn'),
  chatList: $('#gpt-chat-list'),
  chatFilter: $('#gpt-chat-filter'),
  thread: $('#gpt-thread'),
  scroll: $('#gpt-scroll'),
  empty: $('#gpt-empty'),
  waView: $('#gpt-wa-view'),
  waComposer: $('#gpt-wa-composer'),
  waComposerHint: $('#gpt-wa-composer-hint'),
  askAi: $('#gpt-ask-ai'),
  suggest: $('#gpt-suggest'),
  input: $('#gpt-input'),
  send: $('#gpt-send'),
  pills: $('#gpt-pills'),
  mention: $('#gpt-mention'),
  title: $('#gpt-title'),
  model: $('#gpt-model'),
  modelBtn: $('#gpt-model-btn'),
  modelLabel: $('#gpt-model-label'),
  modelMenu: $('#gpt-model-menu'),
  modelFilter: $('#gpt-model-filter'),
  modelList: $('#gpt-model-list'),
  modelManage: $('#gpt-model-manage'),
  sync: $('#gpt-sync'),
  syncLabel: $('#gpt-sync-label'),
  syncPct: $('#gpt-sync-pct'),
  syncFill: $('#gpt-sync-fill'),
  syncDetail: $('#gpt-sync-detail'),
};

const HIDDEN_MODELS_KEY = 'wgpt.hiddenModels';
const OPEN_TABS_KEY = 'wgpt.openTabs';
const ACTIVE_TAB_KEY = 'wgpt.activeTab';
const THEME_KEY = 'wgpt.theme';
const DRAFT = '__new__';

/** @typedef {{ kind: 'draft' } | { kind: 'gpt', id: string } | { kind: 'chat', jid: string, name?: string }} Tab */

function normalizeTab(item) {
  if (!item) return { kind: 'draft' };
  if (typeof item === 'string') {
    if (item === DRAFT || item === '__new__') return { kind: 'draft' };
    if (item.startsWith('chat:')) return { kind: 'chat', jid: item.slice(5) };
    return { kind: 'gpt', id: item };
  }
  if (item.kind === 'chat' && item.jid) return { kind: 'chat', jid: String(item.jid), name: item.name || '' };
  if (item.kind === 'gpt' && item.id) return { kind: 'gpt', id: String(item.id) };
  if (item.kind === 'draft') return { kind: 'draft' };
  return { kind: 'draft' };
}

function loadOpenTabs() {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) || '[]');
    if (!Array.isArray(raw) || !raw.length) return [{ kind: 'draft' }];
    const tabs = raw.map(normalizeTab);
    const seen = new Set();
    return tabs.filter((t) => {
      const k = tabKey(t);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } catch { return [{ kind: 'draft' }]; }
}

function tabKey(t) {
  if (!t || t.kind === 'draft') return DRAFT;
  if (t.kind === 'chat') return `chat:${t.jid}`;
  return t.id;
}

const state = {
  conversationId: null,
  /** Active WhatsApp chat tab jid (null when a GPT tab is focused). */
  activeChatJid: null,
  /** When set (e.g. Ask AI from a chat), retrieval/tools prefer this single chat. */
  scopeChatJid: null,
  pins: [],
  conversations: [],
  chats: [],
  /** @type {Tab[]} */
  openTabs: loadOpenTabs(),
  /** Cached messages for open chat tabs: jid → rows */
  chatMessages: new Map(),
  streaming: null,
  mention: { open: false, kind: 'chat', items: [], index: 0, ctrl: null },
  /** null = Auto (app default); { provider, model } = explicit pick for this thread. */
  model: null,
  /** True once the user changed the picker since the thread loaded, so the next send carries it. */
  modelDirty: false,
  catalog: null,
  manageModels: false,
  hiddenModels: new Set(JSON.parse(localStorage.getItem(HIDDEN_MODELS_KEY) || '[]')),
};

// A stream belongs to its conversation, not to whichever tab is currently visible.
const activeStreams = new Map();

function persistTabs() {
  localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(state.openTabs));
}

function activeTabKey() {
  if (state.activeChatJid) return `chat:${state.activeChatJid}`;
  return state.conversationId || DRAFT;
}

let restoringTabs = true;

function syncWaComposerUi() {
  const inChat = !!state.activeChatJid;
  if (els.waComposer) els.waComposer.hidden = !inChat;
  if (els.askAi) els.askAi.hidden = !inChat;
  store.activeChat = state.activeChatJid || null;
  updateComposerVisibility();
  const canSend = canSendMessageToJid(store.activeChat);
  if (els.waComposerHint) els.waComposerHint.hidden = !inChat || canSend;
}

function setMode(mode) {
  els.app.classList.toggle('mode-chat', mode === 'chat');
  els.app.classList.toggle('mode-gpt', mode !== 'chat');
  if (mode === 'chat') {
    els.waView.hidden = false;
    els.empty.hidden = true;
  } else {
    els.waView.hidden = true;
    clearReplyTarget();
    clearEditTarget();
  }
  syncWaComposerUi();
}

/** WhatsApp Web–style history bar; `progress` is WhatsApp's own 0–100 figure, null when unreported. */
function renderSyncBar(sync) {
  if (!els.sync) return;
  // Once the socket is READY the chat list is usable. Keeping the bar up after that
  // (including a stale 100% from a late history batch) made opening a chat look hung.
  const stillLoading = sync?.syncing && store._waState === 'SYNCING';
  if (!stillLoading) {
    els.sync.hidden = true;
    return;
  }
  els.sync.hidden = false;
  const pct = Number.isFinite(sync.progress) ? Math.round(sync.progress) : null;
  els.sync.classList.toggle('indeterminate', pct == null);
  els.syncFill.style.width = pct == null ? '' : `${pct}%`;
  els.syncPct.textContent = pct == null ? '' : `${pct}%`;
  els.syncLabel.textContent = 'Loading chats';
  const n = Number(sync.messages) || 0;
  els.syncDetail.textContent = n
    ? `${n.toLocaleString()} messages received · keep your phone connected`
    : 'Keep your phone connected';
}

function connectSyncSocket() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host);
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'sync-progress') {
      renderSyncBar({ syncing: !msg.data?.done, progress: msg.data?.progress, messages: msg.data?.messages });
      if (msg.data?.done) void loadChats();
    } else if (msg.type === 'wa-status') {
      void syncWaState();
    }
  };
  ws.onclose = () => { setTimeout(connectSyncSocket, 3000); };
}

async function syncWaState() {
  const prev = store._waState;
  try {
    const st = await fetch('/api/wa/status', { headers: authHeaders() }).then((r) => (r.ok ? r.json() : null));
    // Route transitions through the shared handler, so the Linked Devices panel reports the
    // same link state this poll stores — setting `_waState` directly left the settings card
    // and its status pill contradicting each other after a dropped connection.
    if (st?.state && st.state !== prev) updateWaUI(st);
    else if (st?.state) store._waState = st.state;
    renderSyncBar(st?.sync);
  } catch { /* ignore */ }
  if (!state.activeChatJid) return;
  syncWaComposerUi();
  if (store._waState !== prev) {
    // Re-paint so reaction/reply affordances match the latest WA link state.
    const cached = state.chatMessages.get(state.activeChatJid);
    if (cached) paintWaMessages(state.activeChatJid, cached);
  }
}

async function reloadActiveWaMessages() {
  const jid = state.activeChatJid;
  if (!jid) return;
  try {
    const res = await fetch(
      `/api/messages?chatJid=${encodeURIComponent(jid)}&limit=${INITIAL_CHAT_MESSAGES_LIMIT}&offset=0`,
      { headers: authHeaders() },
    );
    const msgs = res.ok ? await res.json() : [];
    const list = Array.isArray(msgs) ? msgs : [];
    state.chatMessages.set(jid, list);
    if (state.activeChatJid === jid) paintWaMessages(jid, list);
  } catch { /* ignore */ }
}

function askAiAboutActiveChat(seed = '') {
  const jid = state.activeChatJid;
  if (!jid) return;
  const title = els.title.textContent
    || displayChatTitle(jid, state.chats.find((c) => c.chatJid === jid)?.chatName || jid);
  // Fresh GPT thread with only this chat as context (drop any pins from browsing other chats).
  state.conversationId = null;
  state.scopeChatJid = jid;
  state.pins = [{ type: 'chat', chatJid: jid, chatName: title }];
  state.activeChatJid = null;
  store.activeChat = null;
  clearReplyTarget();
  clearEditTarget();
  els.thread.innerHTML = '';
  ensureTab({ kind: 'draft' });
  setMode('gpt');
  refreshStreamingUi();
  els.title.textContent = `Ask about ${title}`;
  els.empty.hidden = true;
  els.input.placeholder = `Ask about ${title}…  (@ to add a chat, / for a skill)`;
  history.replaceState(null, '', '/gpt');
  state.modelDirty = !!state.model;
  renderModelLabel();
  renderTabs();
  renderPills();
  renderChats();
  if (seed) void send(seed);
  else els.input.focus();
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(THEME_KEY, t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'dark' ? '#0b141a' : '#f3f3f3';
  document.querySelectorAll('.gpt-theme-opt').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === t));
  });
}

const SUGGESTIONS = [
  'Catch me up on everything important from today',
  'What did I promise to do for people this week?',
  'Who is waiting on a reply from me?',
  'Summarize the last week in my busiest group',
];

function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (window.SearchableAccount) Object.assign(h, window.SearchableAccount.authHeaders());
  return h;
}

/* ── Markdown (small, escape-first) ───────────────────────────────── */

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>');
}

function renderMarkdown(src, refs = {}) {
  const order = [];
  const cite = (id) => {
    let n = order.indexOf(id);
    if (n < 0) { order.push(id); n = order.length - 1; }
    const r = refs[id];
    const tip = r ? `${r.sender} · ${r.chatName}: ${String(r.text || '').slice(0, 140)}` : `Message m${id}`;
    return `<button type="button" class="cite" data-ref="${escAttr(id)}" title="${escAttr(tip)}">${n + 1}</button>`;
  };
  const blocks = String(src || '').split(/```/);
  let html = '';
  blocks.forEach((block, i) => {
    if (i % 2 === 1) {
      html += `<pre><code>${esc(block.replace(/^\w*\n/, ''))}</code></pre>`;
      return;
    }
    const lines = esc(block).split('\n');
    let list = null;
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    let para = [];
    const flush = () => { if (para.length) { html += `<p>${para.join('<br>')}</p>`; para = []; } };
    for (const raw of lines) {
      const line = inline(raw).replace(/\[m(\d+)\]/g, (_, id) => cite(id));
      const h = raw.match(/^(#{1,3})\s+(.*)$/);
      const ul = raw.match(/^\s*[-*•]\s+(.*)$/);
      const ol = raw.match(/^\s*\d+[.)]\s+(.*)$/);
      if (h) { flush(); close(); html += `<h${h[1].length + 2}>${line.replace(/^#{1,3}\s+/, '')}</h${h[1].length + 2}>`; continue; }
      if (ul || ol) {
        flush();
        const want = ul ? 'ul' : 'ol';
        if (list !== want) { close(); html += `<${want}>`; list = want; }
        html += `<li>${line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')}</li>`;
        continue;
      }
      if (!raw.trim()) { flush(); close(); continue; }
      close();
      para.push(line);
    }
    flush(); close();
  });
  return html;
}

/* ── Time helpers ─────────────────────────────────────────────────── */

function fmtTs(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function bucket(ts) {
  const d = new Date(ts * 1000);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000;
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  if (diff < 30) return 'Previous 30 days';
  return 'Older';
}

/* ── Tabs + thread search + WhatsApp chats ────────────────────────── */

function tabTitle(t) {
  const tab = typeof t === 'string' ? state.openTabs.find((x) => tabKey(x) === t) || normalizeTab(t) : t;
  if (!tab || tab.kind === 'draft') return 'New chat';
  if (tab.kind === 'chat') {
    return tab.name || displayChatTitle(tab.jid, state.chats.find((c) => c.chatJid === tab.jid)?.chatName || tab.jid);
  }
  const c = state.conversations.find((x) => x.id === tab.id);
  return c?.title || 'Chat';
}

function ensureTab(tab) {
  const t = normalizeTab(tab);
  const key = tabKey(t);
  const idx = state.openTabs.findIndex((x) => tabKey(x) === key);
  if (idx >= 0) {
    if (t.kind === 'chat' && t.name) state.openTabs[idx] = { ...state.openTabs[idx], name: t.name };
  } else {
    state.openTabs.push(t);
  }
  persistTabs();
}

/** Close one or more tabs by key. Keeps a draft if the bar would be empty. */
function closeTabsByKeys(keys) {
  const keySet = new Set(keys);
  if (!keySet.size) return;
  const active = activeTabKey();
  const activeIdx = state.openTabs.findIndex((t) => tabKey(t) === active);
  const wasActiveClosed = keySet.has(active);

  state.openTabs = state.openTabs.filter((t) => {
    const k = tabKey(t);
    if (!keySet.has(k)) return true;
    if (t.kind === 'chat') state.chatMessages.delete(t.jid);
    return false;
  });
  if (!state.openTabs.length) state.openTabs.push({ kind: 'draft' });
  persistTabs();

  if (wasActiveClosed) {
    const next = state.openTabs[Math.max(0, Math.min(activeIdx - 1, state.openTabs.length - 1))]
      || state.openTabs[0];
    void activateTab(next);
  } else {
    renderTabs();
  }
}

function closeTab(key) {
  closeTabsByKeys([key]);
}

function closeOtherTabs(key) {
  closeTabsByKeys(state.openTabs.map(tabKey).filter((k) => k !== key));
}

function closeTabsToLeft(key) {
  const idx = state.openTabs.findIndex((t) => tabKey(t) === key);
  if (idx <= 0) return;
  closeTabsByKeys(state.openTabs.slice(0, idx).map(tabKey));
}

function closeTabsToRight(key) {
  const idx = state.openTabs.findIndex((t) => tabKey(t) === key);
  if (idx < 0 || idx >= state.openTabs.length - 1) return;
  closeTabsByKeys(state.openTabs.slice(idx + 1).map(tabKey));
}

function closeAllTabs() {
  closeTabsByKeys(state.openTabs.map(tabKey));
}

let tabMenuKey = null;

function closeTabMenu() {
  tabMenuKey = null;
  const menu = els.tabMenu;
  if (!menu) return;
  menu.hidden = true;
}

function openTabMenu(clientX, clientY, key) {
  const menu = els.tabMenu;
  if (!menu) return;
  tabMenuKey = key;
  const idx = state.openTabs.findIndex((t) => tabKey(t) === key);
  const n = state.openTabs.length;
  menu.querySelector('[data-tab-action="close-others"]')?.toggleAttribute('disabled', n <= 1);
  menu.querySelector('[data-tab-action="close-left"]')?.toggleAttribute('disabled', idx <= 0);
  menu.querySelector('[data-tab-action="close-right"]')?.toggleAttribute('disabled', idx < 0 || idx >= n - 1);
  menu.querySelector('[data-tab-action="close-all"]')?.toggleAttribute('disabled', n <= 1 && state.openTabs[0]?.kind === 'draft');
  menu.hidden = false;
  const pad = 8;
  const w = menu.offsetWidth || 200;
  const h = menu.offsetHeight || 180;
  menu.style.left = `${Math.min(clientX, window.innerWidth - w - pad)}px`;
  menu.style.top = `${Math.min(clientY, window.innerHeight - h - pad)}px`;
}

const tabDrag = { key: null, moved: false };

function reorderTabs(fromKey, toKey, placeAfter = false) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const from = state.openTabs.findIndex((t) => tabKey(t) === fromKey);
  let to = state.openTabs.findIndex((t) => tabKey(t) === toKey);
  if (from < 0 || to < 0) return;
  const [item] = state.openTabs.splice(from, 1);
  if (from < to) to -= 1;
  const insertAt = placeAfter ? to + 1 : to;
  state.openTabs.splice(insertAt, 0, item);
  persistTabs();
  renderTabs();
}

function renderTabs() {
  const active = activeTabKey();
  if (!restoringTabs) localStorage.setItem(ACTIVE_TAB_KEY, active);
  if (!state.openTabs.some((t) => tabKey(t) === active)) {
    if (state.activeChatJid) ensureTab({ kind: 'chat', jid: state.activeChatJid });
    else if (state.conversationId) ensureTab({ kind: 'gpt', id: state.conversationId });
    else ensureTab({ kind: 'draft' });
  }
  els.tabs.innerHTML = state.openTabs.map((t) => {
    const key = tabKey(t);
    const on = key === active ? ' active' : '';
    const wa = t.kind === 'chat' ? ' wa' : '';
    const title = tabTitle(t);
    return `<button type="button" class="gpt-tab${on}${wa}" draggable="true" data-tab="${escAttr(key)}" title="${escAttr(title)}">
      <span class="t">${esc(title)}</span>
      <span class="x" data-close-tab="${escAttr(key)}" title="Close" aria-label="Close tab" draggable="false">×</span>
    </button>`;
  }).join('');
}

async function activateTab(tab) {
  const t = normalizeTab(tab);
  if (t.kind === 'chat') return openChatTab(t.jid, t.name);
  if (t.kind === 'gpt') return openConversation(t.id);
  return newChat();
}

async function loadThreads() {
  try {
    const res = await fetch('/api/gpt/conversations?limit=100', { headers: authHeaders() });
    if (!res.ok) throw new Error('Could not load conversations');
    const data = await res.json();
    state.conversations = data.conversations || [];
  } catch {
    // Keep both the last-known thread list and open tabs. A transient request
    // failure must never erase the user's locally persisted tab references.
    renderTabs();
    renderThreads();
    return;
  }
  // Open tabs are a separate, persistent user choice. The thread sidebar is
  // limited to recent conversations, so it cannot be used to validate tabs.
  if (!state.openTabs.length) state.openTabs = [{ kind: 'draft' }];
  persistTabs();
  renderTabs();
  renderThreads();
}

function renderThreads() {
  const q = (els.filter?.value || '').trim().toLowerCase();
  const rows = state.conversations.filter((c) => !q || String(c.title || '').toLowerCase().includes(q));
  let html = '';
  let last = '';
  for (const c of rows) {
    const b = bucket(c.updatedAt || c.createdAt);
    if (b !== last) { html += `<div class="gpt-bucket">${b}</div>`; last = b; }
    const active = c.id === state.conversationId ? ' active' : '';
    html += `<div class="gpt-thread-item${active}" data-id="${escAttr(c.id)}">
      <span class="t">${esc(c.title || 'Untitled')}</span>
      <button type="button" class="del" data-del="${escAttr(c.id)}" title="Delete thread" aria-label="Delete thread">×</button>
    </div>`;
  }
  els.threads.innerHTML = html || '<div class="gpt-bucket muted">No threads yet</div>';
}

function openThreadSearch(open = true) {
  els.threadSearch.hidden = !open;
  if (open) {
    closeSettings();
    renderThreads();
    els.filter.value = '';
    els.filter.focus();
  }
}

function closeThreadSearch() { els.threadSearch.hidden = true; }

function openSettings(open = true) {
  els.settings.hidden = !open;
  if (open) {
    closeThreadSearch();
    applyTheme(currentTheme());
  }
}

function closeSettings() { els.settings.hidden = true; }

async function loadChats() {
  try {
    const res = await fetch('/api/chats', { headers: authHeaders() });
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    state.chats = Array.isArray(data) ? data : (data.chats || []);
    store.chatData = state.chats;
  } catch { state.chats = []; store.chatData = []; }
  autoSelectSidebarTab();
  renderChats();
}

function gptSidebarEmptyHtml() {
  if (store.sidebarListTab === 'imported') {
    return 'No imported chats yet.<br><span style="opacity:.85;font-size:13px">Tap <strong>+</strong> to import a WhatsApp export.</span>';
  }
  if (!isWaUiReady()) {
    return 'WhatsApp isn’t linked.<br><span style="opacity:.85;font-size:13px">Open Settings → Linked Devices to scan the QR code.</span>';
  }
  return 'No WhatsApp chats synced yet.<br><span style="opacity:.85;font-size:13px">They appear here as sync progresses.</span>';
}

function renderChats() {
  const q = (els.chatFilter?.value || '').trim().toLowerCase();
  const tab = store.sidebarListTab === 'chat' ? 'chat' : 'imported';
  const rows = state.chats
    .filter((c) => {
      if (!c?.chatJid || c.chatJid === 'status@broadcast') return false;
      if (sidebarTabOf(c) !== tab) return false;
      if (!q) return true;
      const name = displayChatTitle(c.chatJid, c.chatName || c.chatJid).toLowerCase();
      return name.includes(q) || String(c.chatJid).toLowerCase().includes(q);
    })
    .sort((a, b) => (b.lastMessageTs || 0) - (a.lastMessageTs || 0));
  renderSidebarTabCounts();
  if (!rows.length) {
    els.chatList.innerHTML = `<div class="sidebar-empty">${gptSidebarEmptyHtml()}</div>`;
    return;
  }
  els.chatList.innerHTML = rows.slice(0, 500).map((c) => chatRowHtml(c)).join('');
  els.chatList.querySelectorAll('.chat-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.jid === state.activeChatJid);
  });
}

function openImportBackup() {
  openOverlay('settings');
  void loadSettings();
  setSettingsTab('backup');
}

async function toggleChatAiIndex(jid, enabled) {
  try {
    const res = await fetch('/api/summaries/index-toggle', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ chatJid: jid, enabled: !!enabled }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not update AI indexing');
    const ch = state.chats.find((c) => c.chatJid === jid);
    if (ch) ch.indexOptedIn = !!enabled;
    renderChats();
  } catch (err) {
    alert(err.message || String(err));
  }
}

function paintWaMessages(jid, msgs) {
  if (!msgs.length) {
    const awaiting = state.chats.find((c) => c.chatJid === jid)?.awaitingSync;
    els.waView.innerHTML = `<div class="empty-messages-state"><div class="empty-messages-title">No messages to show</div><div class="empty-messages-hint">${
      awaiting
        ? 'This chat is still waiting for WhatsApp history. Keep the app linked — new and synced messages will appear here.'
        : 'No messages in this chat yet.'
    }</div></div>`;
    return;
  }
  const sorted = [...msgs].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  els.waView.innerHTML = buildChatMessagesHtml(sorted, jid, null, null);
  els.waView.scrollTop = els.waView.scrollHeight;
}

async function openChatTab(jid, name = '', { pushUrl = true } = {}) {
  if (!jid) return;
  const row = state.chats.find((c) => c.chatJid === jid) || { chatJid: jid };
  const wantTab = sidebarTabOf(row);
  if ((wantTab === 'imported' || wantTab === 'chat') && wantTab !== store.sidebarListTab) {
    setSidebarListTab(wantTab, { pin: false });
  }
  const title = name || displayChatTitle(jid, state.chats.find((c) => c.chatJid === jid)?.chatName || jid);
  ensureTab({ kind: 'chat', jid, name: title });
  state.activeChatJid = jid;
  store.activeChat = jid;
  state.conversationId = null;
  state.scopeChatJid = null;
  clearReplyTarget();
  clearEditTarget();
  setMode('chat');
  refreshStreamingUi();
  els.title.textContent = title;
  renderTabs();
  renderChats();
  closeThreadSearch();
  if (pushUrl) history.replaceState(null, '', `/gpt?chat=${encodeURIComponent(jid)}`);
  if (matchMedia('(max-width: 820px)').matches) els.app.classList.add('chats-hidden');

  if (state.chatMessages.has(jid)) {
    paintWaMessages(jid, state.chatMessages.get(jid));
  } else {
    els.waView.innerHTML = '<div class="gpt-wa-loading">Loading messages…</div>';
  }
  try {
    const res = await fetch(
      `/api/messages?chatJid=${encodeURIComponent(jid)}&limit=${INITIAL_CHAT_MESSAGES_LIMIT}&offset=0`,
      { headers: authHeaders() },
    );
    const msgs = res.ok ? await res.json() : [];
    const list = Array.isArray(msgs) ? msgs : [];
    state.chatMessages.set(jid, list);
    if (state.activeChatJid === jid) paintWaMessages(jid, list);
    fetch(`/api/chats/${encodeURIComponent(jid)}/seen`, {
      method: 'POST', headers: authHeaders(), body: '{}',
    }).catch(() => {});
    void syncWaState();
  } catch {
    if (state.activeChatJid === jid) {
      els.waView.innerHTML = '<div class="empty-messages-state"><div class="empty-messages-title">Could not load messages</div></div>';
    }
  }
  syncWaComposerUi();
  document.getElementById('msg-text')?.focus?.();
}

async function openConversation(id, { pushUrl = true } = {}) {
  let data;
  try {
    const res = await fetch(`/api/gpt/conversations/${encodeURIComponent(id)}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(res.status === 404 ? 'This conversation could not be found.' : 'Could not load this conversation.');
    data = await res.json();
  } catch (err) {
    // Keep the requested tab and its saved ID so a transient API failure does
    // not replace the conversation with a blank draft. Selecting the tab again
    // retries the fetch.
    state.conversationId = id;
    state.activeChatJid = null;
    store.activeChat = null;
    setMode('gpt');
    refreshStreamingUi();
    els.title.textContent = 'Chat';
    els.thread.innerHTML = `<div class="gpt-msg gpt-error">${esc(err.message || 'Could not load this conversation.')}</div>`;
    renderTabs();
    if (pushUrl) history.replaceState(null, '', `/gpt?c=${encodeURIComponent(id)}`);
    return;
  }
  state.conversationId = id;
  state.activeChatJid = null;
  store.activeChat = null;
  clearReplyTarget();
  clearEditTarget();
  ensureTab({ kind: 'gpt', id });
  // Drop empty draft tab when focusing a real GPT thread (Cursor-like).
  if (state.openTabs.some((t) => t.kind === 'draft') && state.openTabs.length > 1) {
    state.openTabs = state.openTabs.filter((t) => t.kind !== 'draft');
    persistTabs();
  }
  state.pins = (data.conversation?.pins || []).map((p) => ({ ...p, saved: true }));
  state.scopeChatJid = data.conversation?.chatJid
    || (state.pins.length === 1 ? state.pins[0].chatJid : null);
  state.model = data.conversation?.model || null;
  state.modelDirty = false;
  renderModelLabel();
  els.title.textContent = data.conversation?.title || 'Chat';
  els.input.placeholder = 'Ask anything, @ a chat, or / a skill';
  setMode('gpt');
  renderMessages(data.messages || []);
  const pendingStream = activeStreams.get(id);
  if (pendingStream?.live?.wrap) {
    els.thread.appendChild(pendingStream.live.wrap);
    els.empty.hidden = true;
  }
  refreshStreamingUi();
  renderPills();
  renderTabs();
  renderThreads();
  renderChats();
  closeThreadSearch();
  if (pushUrl) history.replaceState(null, '', `/gpt?c=${encodeURIComponent(id)}`);
  if (matchMedia('(max-width: 820px)').matches) els.app.classList.add('chats-hidden');
}

function newChat() {
  state.conversationId = null;
  state.activeChatJid = null;
  store.activeChat = null;
  state.scopeChatJid = null;
  clearReplyTarget();
  clearEditTarget();
  ensureTab({ kind: 'draft' });
  state.pins = [];
  els.thread.innerHTML = '';
  els.title.textContent = 'New chat';
  els.empty.hidden = false;
  els.input.placeholder = 'Ask anything, @ a chat, or / a skill';
  setMode('gpt');
  refreshStreamingUi();
  history.replaceState(null, '', '/gpt');
  // Keep the current pick for the new thread (Cursor does the same); it is sent with the first message.
  state.modelDirty = !!state.model;
  renderModelLabel();
  renderPills();
  renderTabs();
  renderThreads();
  renderChats();
  els.input.focus();
}

/* ── Message rendering ────────────────────────────────────────────── */

function sourceCards(sources = []) {
  if (!sources.length) return '';
  const who = [...new Set(sources.map((s) => s.chatName).filter(Boolean))].slice(0, 2).join(', ');
  return `<details class="gpt-sources-wrap"><summary>${sources.length} source${sources.length === 1 ? '' : 's'}${who ? ` · ${esc(who)}` : ''}</summary>
    <div class="gpt-sources">${sources.map((s, i) => `
    <button type="button" class="gpt-source" data-ref="${escAttr(String(s.ref || '').replace(/^m/, ''))}" data-pin-jid="${escAttr(s.chatJid || '')}" data-pin-name="${escAttr(s.chatName || '')}">
      <span class="n">${i + 1}</span>
      <span class="meta">${esc(s.sender)} · ${esc(s.chatName || '')} · ${esc(fmtTs(s.timestamp))}</span>
      <span class="txt">${esc(String(s.text || '').slice(0, 180))}</span>
    </button>`).join('')}</div></details>`;
}

function skillChoicesHtml(choices = []) {
  if (!choices.length) return '';
  return `<div class="gpt-skill-choices">${choices.map((c) =>
    `<button type="button" class="chip" data-skill-choice="${escAttr(c.message)}">${esc(c.label)}</button>`).join('')}</div>`;
}

function skillSendHtml(skillRun) {
  if (!skillRun) return '';
  if (skillRun.status === 'sent') return '<p class="gpt-skill-sent">Sent to the WhatsApp chat.</p>';
  if (!skillRun.canSend) return '';
  return `<button type="button" class="gpt-skill-send" data-send-skill-run="${escAttr(skillRun.id)}">Send report to the chat</button>`;
}

function stepsHtml(steps = [], open = false) {
  if (!steps.length) return '';
  const label = steps.length === 1 ? steps[0] : `${steps.length} steps`;
  return `<details class="gpt-steps"${open ? ' open' : ''}><summary>${esc(label)}</summary>
    <ul>${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>`;
}

function assistantHtml(m) {
  const p = m.payload || {};
  const model = p.model?.model ? `<span class="gpt-msg-model" title="${escAttr(`${p.model.provider} · ${p.model.model}`)}">${esc(shortModel(p.model.model))}</span>` : '';
  return `<div class="gpt-msg gpt-assistant">
    ${stepsHtml(p.steps || [])}
    <div class="gpt-md">${renderMarkdown(m.content, p.refs || {})}</div>
    ${p.expenseDiff ? renderExpenseDiff(p.expenseDiff) : ''}
    ${skillChoicesHtml(p.choices)}
    ${skillSendHtml(p.skillRun)}
    <div class="gpt-msg-foot">${sourceCards(p.sources || [])}${model}</div>
  </div>`;
}

function userHtml(m) {
  const mentions = m.payload?.mentions || [];
  const chips = mentions.length
    ? `<div class="gpt-user-ctx">${mentions.map((p) => `<span class="pill">@${esc(p.chatName || p.chatJid)}</span>`).join('')}</div>`
    : '';
  return `<div class="gpt-msg gpt-user">${chips}<div class="bubble">${esc(m.content).replace(/\n/g, '<br>')}</div></div>`;
}

function renderMessages(messages) {
  els.empty.hidden = messages.length > 0;
  els.thread.innerHTML = messages.map((m) => (m.role === 'assistant' ? assistantHtml(m) : userHtml(m))).join('');
  scrollToBottom(true);
}

function nearBottom() {
  const s = els.scroll;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (force || nearBottom()) els.scroll.scrollTop = els.scroll.scrollHeight;
}

/* ── Model picker ─────────────────────────────────────────────────── */

function shortModel(id) {
  return String(id || '').replace(/^[^/]+\//, '').replace(/:free$/, '').replace(/-latest$/, '');
}

function modelKey(provider, model) { return `${provider}/${model}`; }

function providerName(id) {
  return state.catalog?.providers.find((p) => p.id === id)?.name || id;
}

async function loadModels() {
  try {
    const res = await fetch('/api/gpt/models', { headers: authHeaders() });
    state.catalog = await res.json();
  } catch { state.catalog = null; }
  renderModelLabel();
  if (!els.modelMenu.hidden) renderModelMenu();
}

function renderModelLabel() {
  const def = state.catalog?.default;
  if (state.model) {
    els.modelLabel.textContent = shortModel(state.model.model);
    els.modelBtn.title = `${providerName(state.model.provider)} · ${state.model.model} (this thread)`;
    els.model.textContent = `${providerName(state.model.provider)} · ${shortModel(state.model.model)}`;
  } else {
    els.modelLabel.textContent = 'Auto';
    els.modelBtn.title = def ? `Auto — uses your default: ${providerName(def.provider)} · ${def.model}` : 'Auto';
    els.model.textContent = def ? `Auto · ${shortModel(def.model)}` : '';
  }
}

function setModel(selection) {
  state.model = selection;
  state.modelDirty = true;
  renderModelLabel();
}

function toggleHidden(key) {
  if (state.hiddenModels.has(key)) state.hiddenModels.delete(key);
  else state.hiddenModels.add(key);
  localStorage.setItem(HIDDEN_MODELS_KEY, JSON.stringify([...state.hiddenModels]));
  renderModelMenu();
}

function renderModelMenu() {
  const cat = state.catalog;
  if (!cat) { els.modelList.innerHTML = '<div class="gpt-model-empty">Could not load models.</div>'; return; }
  const q = els.modelFilter.value.trim().toLowerCase();
  const manage = state.manageModels;
  els.modelManage.classList.toggle('on', manage);
  els.modelManage.textContent = manage ? 'Done' : 'Manage';

  const selectedKey = state.model ? modelKey(state.model.provider, state.model.model) : null;
  let html = '';
  if (!q) {
    html += `<button type="button" class="gpt-model-opt${state.model ? '' : ' on'}" data-auto="1" role="option">
      <span class="chk">${state.model ? '' : '✓'}</span>
      <span class="nm">Auto</span>
      <span class="sub">${esc(providerName(cat.default.provider))} · ${esc(shortModel(cat.default.model))}</span>
    </button>`;
  }
  const providers = [...cat.providers].sort((a, b) => Number(b.configured) - Number(a.configured));
  for (const p of providers) {
    const rows = p.models.filter((m) => {
      const hidden = state.hiddenModels.has(modelKey(p.id, m));
      if (hidden && !manage) return false;
      return !q || m.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
    });
    if (!rows.length && !(manage && !q)) continue;
    const tag = p.id === 'ollama' ? 'local' : p.free ? 'free tier' : 'paid';
    html += `<div class="gpt-model-group">
      <div class="gpt-model-group-head">
        <span class="gname">${esc(p.name)}</span>
        <span class="gtag">${tag}</span>
        ${p.configured ? '' : `<button type="button" class="gkey" data-addkey="${escAttr(p.id)}">Add API key</button>`}
      </div>
      <div class="gpt-model-keyrow" data-keyrow="${escAttr(p.id)}" hidden>
        <input type="password" placeholder="${esc(p.name)} API key" autocomplete="off" data-keyinput="${escAttr(p.id)}">
        <button type="button" data-savekey="${escAttr(p.id)}">Save</button>
      </div>`;
    for (const m of rows) {
      const key = modelKey(p.id, m);
      const hidden = state.hiddenModels.has(key);
      const on = key === selectedKey;
      html += `<button type="button" class="gpt-model-opt${on ? ' on' : ''}${p.configured ? '' : ' off'}${hidden ? ' hidden-model' : ''}"
          role="option" data-provider="${escAttr(p.id)}" data-model="${escAttr(m)}" ${p.configured || manage ? '' : 'disabled'}>
        <span class="chk">${on ? '✓' : ''}</span>
        <span class="nm">${esc(shortModel(m))}</span>
        <span class="sub">${esc(m !== shortModel(m) ? m : '')}</span>
        ${manage ? `<span class="eye" data-eye="${escAttr(key)}" title="${hidden ? 'Show in list' : 'Hide from list'}">${hidden ? 'Hidden' : 'Shown'}</span>` : ''}
      </button>`;
    }
    html += '</div>';
  }
  els.modelList.innerHTML = html || '<div class="gpt-model-empty">No models match.</div>';
}

function openModelMenu(open) {
  els.modelMenu.hidden = !open;
  els.modelBtn.classList.toggle('open', open);
  if (open) {
    if (!state.catalog) void loadModels();
    renderModelMenu();
    els.modelFilter.value = '';
    els.modelFilter.focus();
  } else {
    state.manageModels = false;
  }
}

async function saveProviderKey(provider, apiKey) {
  const res = await fetch('/api/gpt/models/key', {
    method: 'PUT', headers: authHeaders(), body: JSON.stringify({ provider, apiKey }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Could not save key');
  }
  await loadModels();
  renderModelMenu();
}

/* ── Pills + @mentions ────────────────────────────────────────────── */

function renderPills() {
  els.pills.innerHTML = state.pins.map((p, i) => `
    <span class="pill" title="${escAttr(p.chatJid)}">@${esc(p.chatName || p.chatJid)}
      <button type="button" data-unpin="${i}" aria-label="Remove">×</button></span>`).join('');
  els.pills.hidden = state.pins.length === 0;
}

async function unpin(index) {
  const [removed] = state.pins.splice(index, 1);
  if (removed?.chatJid && removed.chatJid === state.scopeChatJid) {
    state.scopeChatJid = state.pins[0]?.chatJid || null;
  }
  renderPills();
  renderChats();
  if (removed?.saved && state.conversationId) {
    await fetch(`/api/gpt/conversations/${encodeURIComponent(state.conversationId)}/pins`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ pins: state.pins.filter((p) => p.saved) }),
    }).catch(() => {});
  }
}

function addPin(item) {
  if (!item?.chatJid || state.pins.some((p) => p.chatJid === item.chatJid)) return;
  state.pins.push({ type: 'chat', chatJid: item.chatJid, chatName: item.chatName });
  renderPills();
  renderChats();
}

function slashQuery() {
  const before = els.input.value.slice(0, els.input.selectionStart);
  const m = before.match(/(^|\s)\/([^\s]*)$/);
  if (!m) return null;
  const query = m[2];
  return { query, start: before.length - query.length - 1 };
}

function mentionQuery() {
  const el = els.input;
  const before = el.value.slice(0, el.selectionStart);
  const m = before.match(/(^|\s)@([^\s@]{0,40})$/);
  return m ? { query: m[2], start: before.length - m[2].length - 1 } : null;
}

async function updateSkills() {
  const sq = slashQuery();
  if (!sq) return closeMention();
  state.mention.kind = 'skill';
  state.mention.ctrl?.abort();
  const ctrl = new AbortController();
  state.mention.ctrl = ctrl;
  try {
    const res = await fetch(`/api/skills?q=${encodeURIComponent(sq.query)}`, { headers: authHeaders(), signal: ctrl.signal });
    const data = await res.json();
    state.mention.items = data.items || [];
  } catch (err) {
    if (err.name === 'AbortError') return;
    state.mention.items = [];
  }
  state.mention.index = 0;
  state.mention.open = true;
  renderMention();
}

async function updateComposerAssist() {
  if (slashQuery()) return updateSkills();
  return updateMention();
}

async function updateMention() {
  const mq = mentionQuery();
  if (!mq) return closeMention();
  state.mention.kind = 'chat';
  state.mention.ctrl?.abort();
  const ctrl = new AbortController();
  state.mention.ctrl = ctrl;
  try {
    const res = await fetch(`/api/gpt/mentions?q=${encodeURIComponent(mq.query)}`, { headers: authHeaders(), signal: ctrl.signal });
    const data = await res.json();
    state.mention.items = data.items || [];
  } catch (err) {
    if (err.name === 'AbortError') return;
    state.mention.items = [];
  }
  state.mention.index = 0;
  state.mention.open = true;
  renderMention();
}

function renderMention() {
  const { items, index, kind } = state.mention;
  els.mention.hidden = !state.mention.open;
  const empty = kind === 'skill' ? 'No matching skills' : 'No matching chats';
  els.mention.innerHTML = items.length
    ? items.map((c, i) => (kind === 'skill'
      ? `<div class="opt${i === index ? ' on' : ''}" role="option" data-i="${i}">
          <span class="nm">${esc(c.name)}</span>
          <span class="sub">/${esc(c.path)} · ${esc(c.kind)}</span></div>`
      : `<div class="opt${i === index ? ' on' : ''}" role="option" data-i="${i}">
          <span class="nm">${esc(c.chatName)}</span>
          <span class="sub">${c.messageCount} msgs${c.lastMessageTs ? ` · ${esc(fmtTs(c.lastMessageTs))}` : ''}</span></div>`)).join('')
    : `<div class="opt muted">${empty}</div>`;
}

function closeMention() {
  state.mention.open = false;
  els.mention.hidden = true;
}

function pickMention(i) {
  const item = state.mention.items[i];
  if (!item) return closeMention();
  if (state.mention.kind === 'skill') {
    const sq = slashQuery();
    const el = els.input;
    const insert = `/${item.path} `;
    if (sq) {
      el.value = el.value.slice(0, sq.start) + insert + el.value.slice(el.selectionStart);
      el.selectionStart = el.selectionEnd = sq.start + insert.length;
    } else {
      const pad = el.value && !/\s$/.test(el.value) ? ' ' : '';
      el.value = `${el.value}${pad}${insert}`;
      el.selectionStart = el.selectionEnd = el.value.length;
    }
    closeMention();
    autosize();
    els.input.focus();
    return;
  }
  const mq = mentionQuery();
  if (mq) {
    const el = els.input;
    el.value = el.value.slice(0, mq.start) + el.value.slice(el.selectionStart);
    el.selectionStart = el.selectionEnd = mq.start;
  }
  addPin(item);
  closeMention();
  autosize();
  els.input.focus();
}

/* ── Streaming turn ───────────────────────────────────────────────── */

function setStreaming(on) {
  els.app.classList.toggle('is-streaming', on);
  els.send.title = on ? 'Stop' : 'Send';
}

function activeStreamKey() {
  if (state.activeChatJid) return null;
  return state.conversationId || DRAFT;
}

function refreshStreamingUi() {
  const key = activeStreamKey();
  const stream = key ? activeStreams.get(key) : null;
  state.streaming = stream || null;
  setStreaming(!!stream);
}

function abortStream() {
  const key = activeStreamKey();
  if (!key) return;
  const stream = activeStreams.get(key);
  if (!stream) return;
  stream.ctrl.abort();
  activeStreams.delete(key);
  stream.live?.wrap?.classList.remove('live');
  refreshStreamingUi();
}

function liveBubble() {
  const wrap = document.createElement('div');
  wrap.className = 'gpt-msg gpt-assistant live';
  wrap.innerHTML = `<details class="gpt-steps" open><summary>Thinking…</summary><ul></ul></details>
    <div class="gpt-md"><span class="caret"></span></div>`;
  els.thread.appendChild(wrap);
  return {
    wrap,
    summary: wrap.querySelector('summary'),
    list: wrap.querySelector('ul'),
    md: wrap.querySelector('.gpt-md'),
    text: '',
    frame: 0,
  };
}

function paintLive(live) {
  if (live.frame) return;
  live.frame = requestAnimationFrame(() => {
    live.frame = 0;
    live.md.innerHTML = `${renderMarkdown(live.text)}<span class="caret"></span>`;
    if (activeStreamKey() === live.conversationId) scrollToBottom();
  });
}

async function send(textOverride = null) {
  if (activeStreams.has(activeStreamKey())) { abortStream(); return; }
  const text = String(textOverride ?? els.input.value).trim();
  if (!text) return;
  closeMention();
  els.input.value = '';
  autosize();
  els.empty.hidden = true;

  const mentions = state.pins.filter((p) => !p.saved).map((p) => ({ type: 'chat', chatJid: p.chatJid, chatName: p.chatName }));
  els.thread.insertAdjacentHTML('beforeend', userHtml({ content: text, payload: { mentions } }));
  const live = liveBubble();
  scrollToBottom(true);

  const isNewConversation = !state.conversationId;
  if (isNewConversation) {
    // Give this turn a durable tab identity before the network request starts.
    // Navigation can abort the stream at any point, including before the
    // server's first SSE event reaches the browser.
    state.conversationId = crypto.randomUUID();
    const draftIdx = state.openTabs.findIndex((t) => t.kind === 'draft');
    if (draftIdx >= 0) state.openTabs[draftIdx] = { kind: 'gpt', id: state.conversationId };
    else ensureTab({ kind: 'gpt', id: state.conversationId });
    persistTabs();
    history.replaceState(null, '', `/gpt?c=${encodeURIComponent(state.conversationId)}`);
    renderTabs();
  }
  const conversationId = state.conversationId;
  live.conversationId = conversationId;
  const ctrl = new AbortController();
  const stream = { ctrl, conversationId, live };
  activeStreams.set(conversationId, stream);
  state.streaming = stream;
  refreshStreamingUi();
  const steps = [];

  try {
    const res = await fetch('/api/gpt/chat', {
      method: 'POST',
      headers: authHeaders(),
      signal: ctrl.signal,
      body: JSON.stringify({
        message: text,
        conversationId: state.conversationId || undefined,
        createConversationIfMissing: isNewConversation,
        scopeChatJid: state.scopeChatJid || undefined,
        mentions: state.pins.map((p) => ({ type: 'chat', chatJid: p.chatJid, chatName: p.chatName })),
        ...(state.modelDirty ? { model: state.model } : {}),
        installId: window.SearchableAccount?.getInstallId?.(),
      }),
    });
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      const data = await res.json();
      live.wrap.remove();
      if (activeStreamKey() === conversationId) showError(data.error || 'Request failed', data.code);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === 'status') {
          live.summary.textContent = ev.text;
        } else if (ev.type === 'conversation') {
          // Persist the new thread as soon as the server creates it. A slash
          // command may still be reconciling when the user switches tabs.
          if (activeStreams.get(conversationId)?.ctrl === ctrl && ev.conversationId) {
            if (ev.conversationId !== conversationId) {
              state.openTabs = state.openTabs.map((t) => t.kind === 'gpt' && t.id === conversationId
                ? { kind: 'gpt', id: ev.conversationId }
                : t);
              ensureTab({ kind: 'gpt', id: ev.conversationId });
              persistTabs();
            }
            if (activeStreamKey() === conversationId) {
              state.conversationId = ev.conversationId;
              history.replaceState(null, '', `/gpt?c=${encodeURIComponent(ev.conversationId)}`);
              renderTabs();
              void loadThreads();
            }
          }
        } else if (ev.type === 'tool') {
          steps.push(ev.text);
          live.list.insertAdjacentHTML('beforeend', `<li>${esc(ev.text)}</li>`);
        } else if (ev.type === 'delta') {
          live.text += ev.text || '';
          paintLive(live);
        } else if (ev.type === 'reset') {
          live.text = '';
          paintLive(live);
        } else if (ev.type === 'error') {
          throw new Error(ev.error || 'Something went wrong');
        } else if (ev.type === 'done') {
          done = ev;
        }
      }
    }
    if (!done) throw new Error('The answer stream ended early.');
    cancelAnimationFrame(live.frame);
    const msg = done.message || { content: done.answer, payload: { sources: done.sources, expenseDiff: done.expenseDiff } };
    const wasActive = activeStreamKey() === conversationId;
    live.wrap.outerHTML = assistantHtml(msg);
    if (done.conversationId && done.conversationId !== conversationId) {
      state.openTabs = state.openTabs.map((t) => t.kind === 'gpt' && t.id === conversationId
        ? { kind: 'gpt', id: done.conversationId }
        : t);
      persistTabs();
    }
    ensureTab({ kind: 'gpt', id: done.conversationId || conversationId });
    if (wasActive) {
      state.conversationId = done.conversationId || conversationId;
      state.activeChatJid = null;
      store.activeChat = null;
      state.pins = (done.conversation?.pins || []).map((p) => ({ ...p, saved: true }));
      state.model = done.conversation?.model || null;
      state.modelDirty = false;
      renderModelLabel();
      renderPills();
      els.title.textContent = done.conversation?.title || els.title.textContent;
      els.input.placeholder = 'Ask anything, @ a chat, or / a skill';
      setMode('gpt');
      els.empty.hidden = true;
      history.replaceState(null, '', `/gpt?c=${encodeURIComponent(state.conversationId)}`);
    }
    renderTabs();
    void loadThreads();
  } catch (err) {
    const wasActive = activeStreamKey() === conversationId;
    if (wasActive) {
      if (err.name === 'AbortError') {
        live.wrap.classList.remove('live');
        live.md.innerHTML = `${renderMarkdown(live.text)}<p class="muted">Stopped.</p>`;
      } else {
        live.wrap.remove();
        showError(err.message);
      }
    }
  } finally {
    if (activeStreams.get(conversationId)?.ctrl === ctrl) activeStreams.delete(conversationId);
    refreshStreamingUi();
    if (activeStreamKey() === conversationId) scrollToBottom();
  }
}

async function confirmSkillSend(btn) {
  const id = btn.dataset.sendSkillRun;
  if (!id || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch(`/api/skills/runs/${encodeURIComponent(id)}/send`, {
      method: 'POST', headers: authHeaders(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not send');
    const note = document.createElement('p');
    note.className = 'gpt-skill-sent';
    note.textContent = 'Sent to the WhatsApp chat.';
    btn.replaceWith(note);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Send report to the chat';
    showError(err.message);
  }
}

function showError(message, code) {
  const needsAccount = code === 'trial_expired' || code === 'account_required';
  els.thread.insertAdjacentHTML('beforeend', `<div class="gpt-msg gpt-error">${esc(message)}${
    needsAccount && window.SearchableAccount ? ' <button type="button" class="gpt-signin" id="gpt-signin">Sign in</button>' : ''}</div>`);
  $('#gpt-signin')?.addEventListener('click', () => window.SearchableAccount?.openGate?.(window.__searchableAppConfig || {}));
  scrollToBottom(true);
}

/* ── Composer ─────────────────────────────────────────────────────── */

function autosize() {
  const el = els.input;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
}

function wire() {
  els.input.addEventListener('input', () => { autosize(); void updateComposerAssist(); });
  els.input.addEventListener('click', () => void updateComposerAssist());
  els.input.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      void updateComposerAssist();
    }
  });
  els.input.addEventListener('keydown', (e) => {
    if (state.mention.open && state.mention.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = state.mention.items.length;
        state.mention.index = (state.mention.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        renderMention();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(state.mention.index); return; }
    }
    if (e.key === 'Escape') {
      if (!els.threadSearch.hidden) { closeThreadSearch(); return; }
      if (!els.settings.hidden) { closeSettings(); return; }
      closeMention();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send(); }
  });
  els.mention.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('[data-i]');
    if (opt) { e.preventDefault(); pickMention(Number(opt.dataset.i)); }
  });
  els.pills.addEventListener('click', (e) => {
    const b = e.target.closest('[data-unpin]');
    if (b) void unpin(Number(b.dataset.unpin));
  });
  $('#gpt-at').addEventListener('click', () => {
    const el = els.input;
    const pos = el.selectionStart ?? el.value.length;
    const pre = el.value.slice(0, pos);
    const insert = (pre && !/\s$/.test(pre) ? ' ' : '') + '@';
    el.value = pre + insert + el.value.slice(pos);
    el.selectionStart = el.selectionEnd = pos + insert.length;
    el.focus();
    void updateComposerAssist();
  });
  $('#gpt-slash')?.addEventListener('click', () => {
    const el = els.input;
    const pos = el.selectionStart ?? el.value.length;
    const pre = el.value.slice(0, pos);
    const insert = (pre && !/\s$/.test(pre) ? ' ' : '') + '/';
    el.value = pre + insert + el.value.slice(pos);
    el.selectionStart = el.selectionEnd = pos + insert.length;
    el.focus();
    void updateComposerAssist();
  });
  els.send.addEventListener('click', () => void send());

  els.modelBtn.addEventListener('click', () => openModelMenu(els.modelMenu.hidden));
  els.modelFilter.addEventListener('input', renderModelMenu);
  els.modelManage.addEventListener('click', () => { state.manageModels = !state.manageModels; renderModelMenu(); });
  els.modelMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { openModelMenu(false); els.input.focus(); } });
  els.modelList.addEventListener('click', async (e) => {
    const eye = e.target.closest('[data-eye]');
    if (eye) { e.stopPropagation(); toggleHidden(eye.dataset.eye); return; }
    const add = e.target.closest('[data-addkey]');
    if (add) {
      const row = els.modelList.querySelector(`[data-keyrow="${CSS.escape(add.dataset.addkey)}"]`);
      if (row) { row.hidden = !row.hidden; row.querySelector('input')?.focus(); }
      return;
    }
    const save = e.target.closest('[data-savekey]');
    if (save) {
      const input = els.modelList.querySelector(`[data-keyinput="${CSS.escape(save.dataset.savekey)}"]`);
      save.disabled = true;
      try { await saveProviderKey(save.dataset.savekey, input?.value || ''); } catch (err) { alert(err.message); save.disabled = false; }
      return;
    }
    const opt = e.target.closest('.gpt-model-opt');
    if (!opt || opt.disabled) return;
    if (state.manageModels && !opt.dataset.auto) return;
    setModel(opt.dataset.auto ? null : { provider: opt.dataset.provider, model: opt.dataset.model });
    openModelMenu(false);
    els.input.focus();
  });
  els.modelList.addEventListener('keydown', (e) => {
    const input = e.target.closest('[data-keyinput]');
    if (input && e.key === 'Enter') {
      e.preventDefault();
      els.modelList.querySelector(`[data-savekey="${CSS.escape(input.dataset.keyinput)}"]`)?.click();
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (!els.modelMenu.hidden
      && !e.target.closest('#gpt-model-menu')
      && !e.target.closest('#gpt-model-btn')) {
      openModelMenu(false);
    }
    if (!els.threadSearch.hidden
      && !e.target.closest('#gpt-thread-search .gpt-popover')
      && !e.target.closest('#gpt-thread-search-btn')) {
      closeThreadSearch();
    }
    if (!els.settings.hidden
      && !e.target.closest('#gpt-settings .gpt-popover')
      && !e.target.closest('#gpt-settings-btn')) {
      closeSettings();
    }
    if (els.tabMenu && !els.tabMenu.hidden && !e.target.closest('#gpt-tab-menu')) {
      closeTabMenu();
    }
  });

  $('#gpt-new').addEventListener('click', newChat);
  els.tabs.addEventListener('click', (e) => {
    if (tabDrag.moved) { tabDrag.moved = false; e.preventDefault(); e.stopPropagation(); return; }
    const close = e.target.closest('[data-close-tab]');
    if (close) { e.stopPropagation(); closeTabMenu(); closeTab(close.dataset.closeTab); return; }
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    void activateTab(normalizeTab(tab.dataset.tab));
  });
  els.tabs.addEventListener('contextmenu', (e) => {
    const tab = e.target.closest('.gpt-tab[data-tab]');
    if (!tab) return;
    e.preventDefault();
    openTabMenu(e.clientX, e.clientY, tab.dataset.tab);
  });
  els.tabs.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tab = e.target.closest('.gpt-tab[data-tab]');
    if (!tab) return;
    e.preventDefault();
    closeTabMenu();
    closeTab(tab.dataset.tab);
  });
  els.tabMenu?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab-action]');
    if (!btn || btn.disabled || !tabMenuKey) return;
    const key = tabMenuKey;
    const action = btn.dataset.tabAction;
    closeTabMenu();
    if (action === 'close') closeTab(key);
    else if (action === 'close-others') closeOtherTabs(key);
    else if (action === 'close-left') closeTabsToLeft(key);
    else if (action === 'close-right') closeTabsToRight(key);
    else if (action === 'close-all') closeAllTabs();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.tabMenu && !els.tabMenu.hidden) closeTabMenu();
  });
  els.tabs.addEventListener('dragstart', (e) => {
    const tab = e.target.closest('.gpt-tab[data-tab]');
    if (!tab || e.target.closest('[data-close-tab]')) { e.preventDefault(); return; }
    tabDrag.key = tab.dataset.tab;
    tabDrag.moved = false;
    tab.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tab.dataset.tab);
    try { e.dataTransfer.setDragImage(tab, 24, 12); } catch { /* ignore */ }
  });
  els.tabs.addEventListener('dragend', () => {
    tabDrag.key = null;
    els.tabs.querySelectorAll('.gpt-tab').forEach((el) => el.classList.remove('dragging', 'drag-over', 'drag-over-after'));
  });
  els.tabs.addEventListener('dragover', (e) => {
    const tab = e.target.closest('.gpt-tab[data-tab]');
    if (!tab || !tabDrag.key || tab.dataset.tab === tabDrag.key) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = tab.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    els.tabs.querySelectorAll('.gpt-tab').forEach((el) => el.classList.remove('drag-over', 'drag-over-after'));
    tab.classList.add(after ? 'drag-over-after' : 'drag-over');
  });
  els.tabs.addEventListener('dragleave', (e) => {
    const tab = e.target.closest('.gpt-tab');
    if (tab && !tab.contains(e.relatedTarget)) tab.classList.remove('drag-over', 'drag-over-after');
  });
  els.tabs.addEventListener('drop', (e) => {
    e.preventDefault();
    const tab = e.target.closest('.gpt-tab[data-tab]');
    const from = tabDrag.key || e.dataTransfer.getData('text/plain');
    if (!tab || !from) return;
    const rect = tab.getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    tabDrag.moved = true;
    reorderTabs(from, tab.dataset.tab, after);
  });

  els.threadSearchBtn.addEventListener('click', () => openThreadSearch(els.threadSearch.hidden));
  els.settingsBtn.addEventListener('click', () => openSettings(els.settings.hidden));
  $('#gpt-settings-close').addEventListener('click', closeSettings);
  $('#gpt-open-models').addEventListener('click', () => {
    closeSettings();
    openModelMenu(true);
  });
  document.querySelectorAll('.gpt-theme-opt').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });

  $('#gpt-chats-toggle').addEventListener('click', () => els.app.classList.add('chats-hidden'));
  $('#gpt-chats-open').addEventListener('click', () => els.app.classList.remove('chats-hidden'));
  $('#gpt-sidebar-settings')?.addEventListener('click', () => {
    openOverlay('settings');
    void loadSettings();
  });
  $('#gpt-btn-import')?.addEventListener('click', openImportBackup);
  document.querySelectorAll('#gpt-chats-pane [data-sidebar-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setSidebarListTab(btn.getAttribute('data-sidebar-tab')));
  });
  store.onSidebarListTabChange = () => renderChats();
  els.chatFilter.addEventListener('input', renderChats);
  els.chatList.addEventListener('click', (e) => {
    const toggle = e.target.closest('.chat-ai-toggle');
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();
      const jid = toggle.closest('.chat-item')?.dataset?.jid;
      if (jid) void toggleChatAiIndex(jid, toggle.getAttribute('aria-pressed') !== 'true');
      return;
    }
    const item = e.target.closest('.chat-item');
    if (!item?.dataset.jid) return;
    const name = item.dataset.name || displayChatTitle(item.dataset.jid, item.dataset.jid);
    void openChatTab(item.dataset.jid, name);
  });

  els.filter.addEventListener('input', renderThreads);
  els.threads.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del;
      await fetch(`/api/gpt/conversations/${encodeURIComponent(id)}`, { method: 'DELETE', headers: authHeaders() }).catch(() => {});
      state.openTabs = state.openTabs.filter((t) => !(t.kind === 'gpt' && t.id === id));
      persistTabs();
      if (id === state.conversationId) newChat();
      else renderTabs();
      void loadThreads();
      return;
    }
    const item = e.target.closest('[data-id]');
    if (item) void openConversation(item.dataset.id);
  });

  els.thread.addEventListener('click', async (e) => {
    const choice = e.target.closest('[data-skill-choice]');
    if (choice?.dataset.skillChoice) { void send(choice.dataset.skillChoice); return; }
    const sendBtn = e.target.closest('[data-send-skill-run]');
    if (sendBtn) { await confirmSkillSend(sendBtn); return; }
    const pin = e.target.closest('[data-pin-jid]');
    if (pin?.dataset.pinJid) {
      addPin({ chatJid: pin.dataset.pinJid, chatName: pin.dataset.pinName || pin.dataset.pinJid });
      renderChats();
      pin.classList.add('flash');
      setTimeout(() => pin.classList.remove('flash'), 900);
      return;
    }
    const c = e.target.closest('.cite');
    if (!c) return;
    const msg = c.closest('.gpt-assistant');
    const card = msg?.querySelector(`.gpt-source[data-ref="${CSS.escape(c.dataset.ref)}"]`);
    if (card) {
      const wrap = card.closest('details');
      if (wrap) wrap.open = true;
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 900);
    }
  });
  els.suggest.innerHTML = SUGGESTIONS.map((s) => `<button type="button" class="chip">${esc(s)}</button>`).join('');
  els.suggest.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) void send(chip.textContent);
  });

  els.askAi?.addEventListener('click', () => askAiAboutActiveChat());

  els.waView?.addEventListener('click', async (e) => {
    const aiBtn = e.target.closest('[data-wa-ai-search]');
    if (aiBtn) {
      const block = e.target.closest('.msg-block');
      if (!block?.dataset?.messageId) return;
      e.stopPropagation();
      const pr = (aiBtn.getAttribute('data-ai-preview') || '').trim();
      const seed = pr
        ? `About this message: ${pr.slice(0, 550)}${pr.length > 550 ? '…' : ''}`
        : 'Summarize the conversation around this message.';
      askAiAboutActiveChat(seed);
      return;
    }
    const rep = e.target.closest('[data-wa-reply]');
    if (rep) {
      const block = e.target.closest('.msg-block');
      if (!block?.dataset?.messageId) return;
      e.stopPropagation();
      setReplyTarget(block.dataset.messageId, rep.getAttribute('data-reply-preview') || '');
      return;
    }
    const reactEl = e.target.closest('[data-wa-react]');
    if (reactEl) {
      const block = e.target.closest('.msg-block');
      if (!block?.dataset?.messageId) return;
      e.stopPropagation();
      try {
        await postWaReaction(
          block.dataset.storageJid || store.activeChat,
          block.dataset.messageId,
          reactEl.getAttribute('data-wa-react') || '👍',
        );
        void reloadActiveWaMessages();
      } catch (err) {
        alert(err.message || 'Reaction failed');
      }
      return;
    }
    const fwd = e.target.closest('[data-wa-forward]');
    if (fwd) {
      e.stopPropagation();
      alert('Forward is available in the classic UI for now.');
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
        fromMe: block.dataset.fromMe === '1',
      });
    }
  });
}

async function boot() {
  applyTheme(localStorage.getItem(THEME_KEY) || 'light');
  store.onActiveChatRefresh = () => reloadActiveWaMessages();
  store.chatData = store.chatData || [];
  setMode('gpt');
  if (matchMedia('(max-width: 820px)').matches) els.app.classList.add('chats-hidden');
  wire();
  autosize();
  window.addEventListener('wgpt:chats-imported', async (ev) => {
    setSidebarListTab('imported', { pin: false });
    await loadChats();
    store.chatData = state.chats;
    const jid = ev.detail?.chatJid;
    if (!jid) return;
    const name = state.chats.find((c) => c.chatJid === jid)?.chatName || jid;
    await openChatTab(jid, name);
  });
  void syncWaState();
  setInterval(() => { void syncWaState(); }, 15000);
  connectSyncSocket();
  const params = new URLSearchParams(location.search);
  await Promise.all([loadThreads(), loadModels(), loadChats()]);
  // Keep classic helpers (title resolution / forward list) in sync with the GPT chat roster.
  store.chatData = state.chats;
  if (params.get('c')) {
    await openConversation(params.get('c'), { pushUrl: false });
  } else if (params.get('chat')) {
    const jid = params.get('chat');
    const name = params.get('name') || state.chats.find((c) => c.chatJid === jid)?.chatName || jid;
    await openChatTab(jid, name, { pushUrl: false });
  } else {
    const savedActiveKey = localStorage.getItem(ACTIVE_TAB_KEY);
    const last = state.openTabs.find((t) => tabKey(t) === savedActiveKey)
      || [...state.openTabs].reverse().find((t) => t.kind !== 'draft')
      || state.openTabs[0];
    // The recent-thread sidebar is capped and can fail independently. A saved
    // open tab is authoritative, so restore it directly by ID instead of
    // requiring it to appear in the sidebar response first.
    if (last?.kind === 'gpt') {
      await openConversation(last.id, { pushUrl: false });
    } else if (last?.kind === 'chat') {
      await openChatTab(last.jid, last.name, { pushUrl: false });
    } else {
      renderTabs();
    }
  }
  const q = params.get('q');
  if (q) void send(q);
  else if (!state.activeChatJid) els.input.focus();
  if (location.hash === '#models') openModelMenu(true);
  if (location.hash === '#settings') openSettings(true);
  restoringTabs = false;
  localStorage.setItem(ACTIVE_TAB_KEY, activeTabKey());
}

void boot();

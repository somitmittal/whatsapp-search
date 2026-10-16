import { store } from './store.js';
import { isSmbBusinessMode } from './business.js';
import { openChat } from './chat-view.js';
import { messageTimestampToDate } from './format.js';
import { switchPanel } from './overlays.js';
import { $, esc, escAttr } from './util.js';
import { renderExpenseDiff } from './expense-sheet-view.js';

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (window.SearchableAccount) Object.assign(headers, window.SearchableAccount.authHeaders());
  return headers;
}

function installId() {
  return window.SearchableAccount ? window.SearchableAccount.getInstallId() : undefined;
}

function followUpInput() {
  return $('#search-followup-input');
}

export function clearSearch() {
  store.searchActive = false;
  store.searchConversationId = null;
  $('#search-results').innerHTML = '';
  $('#search-loading').classList.remove('visible');
  const follow = $('#search-followup');
  if (follow) follow.hidden = true;
  const fu = followUpInput();
  if (fu) fu.value = '';
  setThreadsOpen(false);
}

/**
 * Open the ChatGPT-style search assistant (used by the Gemini/sparkle button).
 * @param {{ showThreads?: boolean, startNew?: boolean, seedQuery?: string, runSeed?: boolean }} [opts]
 */
export async function openSearchAssistant(opts = {}) {
  const {
    showThreads = true,
    startNew = false,
    seedQuery = '',
    runSeed = false,
  } = opts;
  if (startNew) store.searchConversationId = null;
  store.searchActive = true;
  switchPanel();
  const follow = $('#search-followup');
  if (follow) follow.hidden = false;
  if (showThreads) setThreadsOpen(true);

  const chatName = store.activeChat
    ? (store.chatData.find((c) => c.chatJid === store.activeChat)?.chatName || 'this chat')
    : 'your chats';

  if (store.searchConversationId && !startNew && !seedQuery) {
    await openConversation(store.searchConversationId);
    followUpInput()?.focus();
    return;
  }

  if (!store.searchConversationId || startNew) {
    $('#search-panel-title').textContent = 'AI search';
    $('#search-results').innerHTML = `<div class="search-chat-empty">Ask anything about <strong>${esc(chatName)}</strong>, open a past thread on the left, or compare today’s expenses with the end-of-day Excel sheet.</div>`;
  }

  if (seedQuery && runSeed) {
    await doSearch(seedQuery);
    return;
  }

  const fu = followUpInput();
  if (fu) {
    fu.placeholder = store.activeChat ? `Ask about ${chatName}…` : 'Ask AI…';
    if (seedQuery) fu.value = seedQuery;
    fu.focus();
  }
}

function formatThreadWhen(updatedAt) {
  if (!updatedAt) return '';
  return new Date(Number(updatedAt) * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

async function fetchConversations(limit = 40) {
  const res = await fetch(`/api/search/conversations?limit=${limit}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load threads');
  return data.conversations || [];
}

function renderThreadButtons(list, { itemClass, activeId }) {
  return list.map((c) => {
    const title = esc(c.title || 'Untitled search');
    const when = formatThreadWhen(c.updatedAt);
    const active = activeId && c.id === activeId ? ' active' : '';
    return `<button type="button" class="${itemClass}${active}" data-conversation-id="${escAttr(c.id)}">
      <span class="search-history-title search-thread-title">${title}</span>
      <span class="search-history-meta search-thread-meta">${esc(when)}</span>
    </button>`;
  }).join('');
}

function setThreadsOpen(open) {
  const aside = $('#search-threads');
  const toggle = $('#btn-search-threads');
  if (!aside) return;
  aside.hidden = !open;
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) void refreshThreadsList();
}

async function refreshThreadsList() {
  const listEl = $('#search-threads-list');
  if (!listEl) return;
  try {
    const list = await fetchConversations(40);
    if (!list.length) {
      listEl.innerHTML = '<div class="search-threads-empty">No past threads yet.<br>Ask something in the search bar to start one.</div>';
      return;
    }
    listEl.innerHTML = renderThreadButtons(list, {
      itemClass: 'search-thread-item',
      activeId: store.searchConversationId,
    });
  } catch {
    listEl.innerHTML = '<div class="search-threads-empty">Could not load threads</div>';
  }
}

async function openConversation(id) {
  store.searchConversationId = id;
  store.searchActive = true;
  switchPanel();
  $('#search-loading').classList.add('visible');
  $('#search-loading-label').textContent = 'Loading…';
  try {
    const res = await fetch(`/api/search/conversations/${encodeURIComponent(id)}`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load conversation');
    $('#search-panel-title').textContent = data.conversation?.title || 'AI search';
    renderConversation(data.messages || []);
    const follow = $('#search-followup');
    if (follow) follow.hidden = false;
    void refreshThreadsList();
    followUpInput()?.focus();
  } catch (err) {
    $('#search-results').innerHTML = `<div class="search-chat-error">${esc(err.message)}</div>`;
  } finally {
    $('#search-loading').classList.remove('visible');
  }
}

export async function doSearch(overrideMessage = null) {
  const fu = followUpInput();
  const query = String(overrideMessage != null ? overrideMessage : (fu?.value || '')).trim();
  if (!query) return;
  const chatJid = store.activeChat || null;
  store.searchActive = true;
  const sendBtn = $('#search-followup-send');
  if (sendBtn) sendBtn.disabled = true;
  switchPanel();
  $('#search-loading').classList.add('visible');
  $('#search-loading-label').textContent = 'Thinking…';

  const follow = $('#search-followup');
  if (follow) follow.hidden = false;

  if (store.searchConversationId) {
    appendOptimisticUser(query);
  } else {
    $('#search-results').innerHTML = '';
  }

  try {
    const res = await fetch('/api/search/chat', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        message: query,
        stream: true,
        conversationId: store.searchConversationId || undefined,
        chatJid,
        mediaType: null,
        businessContext: store.sidebarListTab === 'business' && isSmbBusinessMode(),
        installId: installId(),
      }),
    });
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      const data = await res.json();
      if (res.status === 402 || data.code === 'trial_expired' || data.code === 'account_required') {
        renderPaywall(data);
      } else if (data.error) {
        $('#search-results').innerHTML = `<div class="search-chat-error">${esc(data.error)}</div>`;
      } else {
        applySearchResult(data, fu);
      }
      return;
    }
    if (!res.ok || !res.body) {
      throw new Error(`Search failed (${res.status})`);
    }
    const data = await readSearchStream(res);
    if (!data) throw new Error('Search ended before a reply');
    applySearchResult(data, fu);
  } catch (err) {
    $('#search-results').innerHTML = `<div class="search-chat-error">${esc(err.message)}</div>`;
  } finally {
    $('#search-loading').classList.remove('visible');
    if (sendBtn) sendBtn.disabled = false;
  }
}

function applySearchResult(data, fu) {
  if (window.SearchableAccount) {
    window.SearchableAccount.track(window.__searchableAppConfig || {}, 'ai_search_run', {});
  }
  store.searchConversationId = data.conversationId || store.searchConversationId;
  if (data.conversation?.title) {
    $('#search-panel-title').textContent = data.conversation.title;
  }
  renderConversation(data.messages || []);
  if (fu) fu.value = '';
  if (!$('#search-threads')?.hidden) void refreshThreadsList();
  fu?.focus();
}

function beginLiveAnswer() {
  const thread = $('#search-results');
  if (!thread || $('#sc-live')) return;
  thread.insertAdjacentHTML('beforeend', `
    <div class="sc-msg sc-assistant" id="sc-live">
      <div class="sc-status" id="sc-live-status">Thinking…</div>
      <div class="sc-bubble" id="sc-live-bubble"><span class="sc-caret"></span></div>
    </div>`);
  thread.scrollTop = thread.scrollHeight;
}

function paintLive(status, text) {
  const statusEl = $('#sc-live-status');
  const bubble = $('#sc-live-bubble');
  if (statusEl && status) statusEl.textContent = status;
  if (bubble) {
    bubble.innerHTML = text
      ? `${formatAnswer(text)}<span class="sc-caret"></span>`
      : '<span class="sc-caret"></span>';
  }
  const thread = $('#search-results');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

async function readSearchStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let answer = '';
  let donePayload = null;
  beginLiveAnswer();
  $('#search-loading').classList.remove('visible');
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop() || '';
    for (const block of blocks) {
      const line = block.split('\n').find((row) => row.startsWith('data:'));
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (ev.type === 'status') paintLive(ev.text, answer);
      else if (ev.type === 'delta') {
        answer += ev.text || '';
        paintLive(null, answer);
      } else if (ev.type === 'done') donePayload = ev;
      else if (ev.type === 'error') throw new Error(ev.error || 'Search failed');
    }
  }
  return donePayload;
}

function renderPaywall(data) {
  const reason = data.code || data.entitlement?.reason || 'account_required';
  let actions = '';
  if (reason === 'trial_expired' && window.__searchableAppConfig?.stripeEnabled && window.SearchableAccount) {
    actions = `<button type="button" class="btn" id="sr-checkout" style="margin-top:12px;background:var(--green);color:#fff;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;">Subscribe to Pro</button>`;
  } else if (window.SearchableAccount) {
    actions = `<button type="button" class="btn" id="sr-signin" style="margin-top:12px;background:var(--green);color:#fff;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;">Sign in for AI search</button>`;
  }
  $('#search-results').innerHTML = `<div style="text-align:center;padding:48px 24px;color:var(--text)">
      <p style="font-weight:600;margin-bottom:8px">${esc(data.error || 'AI search requires an account')}</p>
      <p style="font-size:13px;color:var(--text2)">Browse and import stay free. Pro unlocks AI search.</p>
      ${actions}
    </div>`;
  const checkout = $('#sr-checkout');
  if (checkout) checkout.onclick = () => {
    window.SearchableAccount.startCheckout(window.__searchableAppConfig || {}).catch((e) => alert(e.message));
  };
  const signin = $('#sr-signin');
  if (signin) signin.onclick = () => {
    window.SearchableAccount.openGate(window.__searchableAppConfig || {});
  };
}

function appendOptimisticUser(text) {
  const thread = $('#search-results');
  if (!thread) return;
  thread.insertAdjacentHTML('beforeend', `
    <div class="sc-msg sc-user">
      <div class="sc-bubble">${esc(text)}</div>
    </div>
  `);
  thread.scrollTop = thread.scrollHeight;
}

function renderConversation(messages) {
  const thread = $('#search-results');
  if (!thread) return;
  if (!messages.length) {
    thread.innerHTML = '<div class="search-chat-empty">Ask anything — try comparing today’s expenses with the end-of-day Excel sheet.</div>';
    return;
  }
  let html = '';
  for (const m of messages) {
    if (m.role === 'user') {
      html += `<div class="sc-msg sc-user"><div class="sc-bubble">${esc(m.content || '')}</div></div>`;
      continue;
    }
    html += `<div class="sc-msg sc-assistant">`;
    html += `<div class="sc-bubble">${formatAnswer(m.content || '')}</div>`;
    if (m.payload?.expenseDiff) {
      html += renderExpenseDiff(m.payload.expenseDiff);
    }
    if (m.payload?.sources?.length) {
      html += renderSources(m.payload.sources);
    }
    html += `</div>`;
  }
  thread.innerHTML = html;
  thread.scrollTop = thread.scrollHeight;
}

function renderSources(sources) {
  let html = '<div class="sources"><h4>Sources</h4>';
  const seen = new Set();
  for (const s of sources) {
    const k = `${s.chatName}|${s.sender}|${s.timestamp}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const sourceDate = messageTimestampToDate(s.timestamp);
    const ts = sourceDate
      ? sourceDate.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
      : 'Unknown date';
    const canJump = s.chatJid && s.messageId;
    const dis = canJump ? '' : ' src-disabled';
    const title = canJump ? 'View in chat' : 'Open the chat from the sidebar to jump (missing id)';
    const dChat = s.chatJid ? ` data-chat-jid="${escAttr(s.chatJid)}"` : '';
    const dMid = s.messageId ? ` data-message-id="${escAttr(s.messageId)}"` : '';
    html += `<div class="src-item${dis}"${dChat}${dMid} title="${escAttr(title)}"><div class="meta">${esc(s.chatName || '')} &bull; ${esc(s.sender || '')} &bull; ${esc(ts)}</div><div>${esc((s.text || '').slice(0, 250))}</div></div>`;
  }
  html += '</div>';
  return html;
}

function formatAnswer(t) {
  let s = esc(t);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

function sendFollowUp() {
  const input = $('#search-followup-input');
  const text = input?.value?.trim();
  if (!text) return;
  const sendBtn = $('#search-followup-send');
  if (sendBtn) sendBtn.disabled = true;
  void doSearch(text);
}

const SEARCH_PANEL_WIDTH_KEY = 'searchable.searchPanelWidth';
/** Matches #panel-search min-width / default width in app.css (and sidebar min-width). */
const SEARCH_PANEL_MIN = 340;
const SEARCH_PANEL_DEFAULT = 480;

function clampSearchPanelWidth(px, parentWidth) {
  const max = Math.max(
    SEARCH_PANEL_MIN,
    Math.min(900, Math.floor(parentWidth - 280)),
  );
  return Math.max(SEARCH_PANEL_MIN, Math.min(max, Math.round(px)));
}

function applySearchPanelWidth(px) {
  const panel = $('#panel-search');
  if (!panel) return;
  const parent = panel.parentElement;
  const parentWidth = parent?.clientWidth || window.innerWidth;
  const width = clampSearchPanelWidth(px, parentWidth);
  panel.style.width = `${width}px`;
  panel.style.maxWidth = 'none';
  return width;
}

function restoreSearchPanelWidth() {
  try {
    const saved = Number(localStorage.getItem(SEARCH_PANEL_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= SEARCH_PANEL_MIN) {
      applySearchPanelWidth(saved);
    }
  } catch { /* ignore */ }
}

function initSearchPanelResize() {
  const handle = $('#search-panel-resizer');
  const panel = $('#panel-search');
  if (!handle || !panel) return;
  restoreSearchPanelWidth();

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const onMove = (e) => {
    if (!dragging) return;
    const clientX = e.touches?.[0]?.clientX ?? e.clientX;
    const next = startWidth + (startX - clientX);
    applySearchPanelWidth(next);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try {
      localStorage.setItem(SEARCH_PANEL_WIDTH_KEY, String(panel.offsetWidth));
    } catch { /* ignore */ }
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('touchmove', onMove);
    window.removeEventListener('touchend', onUp);
  };
  const onDown = (e) => {
    if (window.matchMedia('(max-width: 700px)').matches) return;
    e.preventDefault();
    dragging = true;
    startX = e.touches?.[0]?.clientX ?? e.clientX;
    startWidth = panel.offsetWidth;
    panel.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
  };

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('touchstart', onDown, { passive: false });
  window.addEventListener('resize', () => {
    if (panel.style.width) applySearchPanelWidth(panel.offsetWidth);
  });
}

export function initSearch() {
  initSearchPanelResize();

  $('#btn-search-threads')?.addEventListener('click', () => {
    const aside = $('#search-threads');
    setThreadsOpen(!!aside?.hidden);
  });
  $('#btn-close-search-threads')?.addEventListener('click', () => setThreadsOpen(false));
  $('#search-threads-list')?.addEventListener('click', (e) => {
    const item = e.target.closest('.search-thread-item');
    if (!item) return;
    const id = item.getAttribute('data-conversation-id');
    if (id) void openConversation(id);
  });

  $('#btn-close-search')?.addEventListener('click', () => {
    setThreadsOpen(false);
    clearSearch();
    switchPanel();
  });
  $('#btn-new-search-chat')?.addEventListener('click', () => {
    store.searchConversationId = null;
    $('#search-results').innerHTML = '<div class="search-chat-empty">New chat — type below, or open a past thread from the menu.</div>';
    $('#search-panel-title').textContent = 'AI search';
    const fu = followUpInput();
    if (fu) {
      fu.value = '';
      fu.focus();
    }
    void refreshThreadsList();
  });

  $('#search-followup-send')?.addEventListener('click', sendFollowUp);
  $('#search-followup-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendFollowUp();
  });

  document.getElementById('btn-chat-ai-search')?.addEventListener('click', () => {
    if (!store.activeChat) return;
    void openSearchAssistant({ showThreads: true, startNew: !store.searchConversationId });
  });

  $('#search-results')?.addEventListener('click', (e) => {
    const item = e.target.closest('.src-item');
    if (!item || item.classList.contains('src-disabled')) return;
    const jid = item.getAttribute('data-chat-jid');
    const mid = item.getAttribute('data-message-id');
    if (!jid || !mid) return;
    e.preventDefault();
    void openChat(jid, mid);
  });
}

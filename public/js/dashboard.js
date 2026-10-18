import { store } from './store.js';
import { loadAwaySummaryForChat } from './away-summary.js';
import { isResolvedChatName, receiptTicksHtml } from './format.js';
import { syncIndexChatMenuItem } from './menus.js';
import { autoSelectSidebarTab, renderChatsFromState, sortChatDataByRecency } from './sidebar.js';
import { refreshStatusFeed } from './status-feed.js';
import { $ } from './util.js';
import { ensureImportFirstWelcome, pollSyncChipPhase, setSyncChipPhase } from './wa-bootstrap.js';
import { adjustSyncingMainPanel, applyLiveSyncVisibility, canShowChatUI, updateSidebarForWaState } from './wa-connection.js';

// ── Dashboard ──────────────────────────────────────────────────────
export function applyUnreadUpdates(updates) {
  if (!Array.isArray(updates) || !updates.length) return;
  let changed = false;
  for (const u of updates) {
    if (!u?.chatJid) continue;
    const row = store.chatData.find((c) => c.chatJid === u.chatJid);
    if (!row) continue;
    const next = Math.max(0, Number(u.unreadCount) || 0);
    if (row.unreadCount !== next) {
      row.unreadCount = next;
      changed = true;
    }
  }
  if (changed) renderChatsFromState();
}

export function mergeSyncChatsPreview(preview) {
  if (!Array.isArray(preview) || !preview.length || !canShowChatUI()) return;
  const byJid = new Map((store.chatData || []).map((c) => [c.chatJid, c]));
  for (const p of preview) {
    if (!p?.chatJid) continue;
    const existing = byJid.get(p.chatJid);
    if (!existing) {
      byJid.set(p.chatJid, { ...p });
      continue;
    }
    const merged = { ...existing, ...p };
    merged.lastMessageTs = Math.max(Number(existing.lastMessageTs) || 0, Number(p.lastMessageTs) || 0);
    if ((existing.messageCount || 0) > (p.messageCount || 0)) {
      merged.messageCount = existing.messageCount;
    }
    // A titles-only preview reports zero for counts it never looked up, which would
    // blank the indexed badge until the next full refresh.
    if ((existing.summarizedCount || 0) > (p.summarizedCount || 0)) {
      merged.summarizedCount = existing.summarizedCount;
    }
    // Sync previews are emitted before contact/subject resolution, so they often carry
    // the bare JID as the name. Letting one overwrite an already-resolved title makes
    // sidebar names flip as previews and /api/chats refreshes race each other.
    if (!isResolvedChatName(p.chatJid, p.chatName)
      && isResolvedChatName(p.chatJid, existing.chatName)) {
      merged.chatName = existing.chatName;
    }
    byJid.set(p.chatJid, merged);
  }
  store.chatData = [...byJid.values()];
  sortChatDataByRecency();
  autoSelectSidebarTab();
  renderChatsFromState();
  adjustSyncingMainPanel();
}

export function refreshDash() {
  if (store._refreshDashInFlight) {
    store._refreshDashQueued = true;
    return store._refreshDashInFlight;
  }
  store._refreshDashInFlight = refreshDashOnce().finally(() => {
    store._refreshDashInFlight = null;
    if (store._refreshDashQueued) {
      store._refreshDashQueued = false;
      void refreshDash();
    }
  });
  return store._refreshDashInFlight;
}

async function refreshDashOnce() {
  try {
    const [chatsRes, statusRes] = await Promise.all([
      fetch('/api/chats'),
      fetch('/api/status'),
    ]);
    if (!chatsRes.ok) {
      console.error('[refreshDash] /api/chats failed:', chatsRes.status, await chatsRes.text().catch(() => ''));
      return;
    }
    const chats = await chatsRes.json();
    const status = statusRes.ok ? await statusRes.json() : null;
    store.chatData = Array.isArray(chats) ? chats : [];
    if (status?.stats) {
      store._archiveMessageCount = status.stats.totalMessages || 0;
      store._archiveChatCount = status.stats.totalChats || 0;
    }
    sortChatDataByRecency();
    if (canShowChatUI()) {
      autoSelectSidebarTab();
      renderChatsFromState();
      adjustSyncingMainPanel();
      ensureImportFirstWelcome();
    } else {
      const list = $('#chat-list');
      if (list) list.innerHTML = '';
    }
    updateSidebarForWaState();
    applyLiveSyncVisibility();
    await refreshStatusFeed();
    if (status?.stats) {
      const s = status.stats;
      if ($('#stat-msgs')) $('#stat-msgs').textContent = s.totalMessages.toLocaleString();
      if ($('#stat-chats')) $('#stat-chats').textContent = s.totalChats;
      if ($('#stat-sums')) $('#stat-sums').textContent = s.totalSummaries;
      if ($('#stat-facts')) $('#stat-facts').textContent = (s.threadFacts ?? 0).toLocaleString();
    }
    store.connected = status?.connected ?? false;
  } catch (err) {
    console.error('[refreshDash]', err);
  }
}

export async function setChatIndexEnabled(jid, enabled) {
  try {
    const r = await fetch('/api/summaries/index-toggle', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatJid: jid, enabled: !!enabled }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    const ch = store.chatData.find((c) => c.chatJid === jid);
    if (ch) ch.indexOptedIn = !!enabled;
    renderChatsFromState();
    syncIndexChatMenuItem();
    void refreshDash();
  } catch (e) {
    alert('Could not update AI indexing: ' + (e.message || String(e)));
  }
}

export function applyChatSummaryBars() {
  const root = $('#chat-list');
  if (!root) return;
  root.querySelectorAll('.chat-index-track').forEach(tr => {
    const jid = tr.dataset.jid;
    const st = store.summaryProgressByJid[jid];
    const bar = tr.querySelector('.chat-index-bar');
    if (!st || !st.show) {
      tr.style.display = 'none';
      if (bar) bar.style.width = '0%';
      return;
    }
    tr.style.display = '';
    if (bar) bar.style.width = st.pct + '%';
  });
}

export function handleSummaryProgress(d) {
  if (!d || d.phase !== 'summary') return;
  if (d.done) {
    store.summaryProgressByJid = {};
    applyChatSummaryBars();
    refreshDash();
    // Media captioning starts once summaries drain — let the server say which phase is next.
    void pollSyncChipPhase();
    return;
  }
  setSyncChipPhase('indexing');
  if (d.started) return;
  if (!d.chatJid) return;
  const jid = d.chatJid;
  if (d.chatComplete) {
    store.summaryProgressByJid[jid] = { pct: 100, show: true };
    applyChatSummaryBars();
    if (store.awaySummarySnapshot?.jid === jid && store.activeChat === jid) {
      void loadAwaySummaryForChat(jid, store.awaySummarySnapshot);
    }
    setTimeout(() => {
      delete store.summaryProgressByJid[jid];
      applyChatSummaryBars();
    }, 450);
    return;
  }
  if (
    d.active === true
    && store.awaySummarySnapshot?.jid === jid
    && store.activeChat === jid
    && (d.threadsDone || 0) > (store.awaySummarySnapshot.lastThreadsDone || 0)
  ) {
    store.awaySummarySnapshot.lastThreadsDone = d.threadsDone || 0;
    void loadAwaySummaryForChat(jid, store.awaySummarySnapshot);
  }
  if (d.active === false) {
    delete store.summaryProgressByJid[jid];
    applyChatSummaryBars();
    return;
  }
  const total = d.threadsTotal || 1;
  const done = Math.min(d.threadsDone ?? 0, total);
  store.summaryProgressByJid[jid] = { pct: Math.round((done / total) * 100), show: true };
  applyChatSummaryBars();
}

export function applySearchIndexBars() {
  const root = $('#chat-list');
  if (!root) return;
  root.querySelectorAll('.search-index-track').forEach(tr => {
    const pct = parseInt(tr.dataset.searchPct, 10);
    const safePct = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
    const done = tr.dataset.searchComplete === '1';
    const bar = tr.querySelector('.search-index-bar');
    tr.classList.toggle('done', done);
    tr.style.display = done ? 'none' : '';
    if (bar) bar.style.width = safePct + '%';
    const sum = parseInt(tr.dataset.summarized, 10) || 0;
    const tot = parseInt(tr.dataset.totalThreads, 10) || 0;
    tr.title = done
      ? 'AI search: all conversation threads in this chat are summarized (thread summaries + facts). Plain text search in messages always works.'
      : (tot > 0
        ? `AI search index: ${sum} of ${tot} threads summarized (${safePct}%). Message search works anytime; summaries improve AI answers.`
        : 'No multi-message threads yet — AI index complete when threads exist.');
  });
}

export function applyMessageReceipt(data) {
  const messageId = data?.messageId;
  if (!messageId) return;
  const ticks = receiptTicksHtml(data.receiptStatus);
  const escId = (window.CSS && CSS.escape) ? CSS.escape(String(messageId)) : String(messageId).replace(/"/g, '');
  document.querySelectorAll(`.msg-block[data-message-id="${escId}"]`).forEach((block) => {
    if (block.dataset.fromMe !== '1') return;
    const time = block.querySelector('.time');
    if (!time || !ticks) return;
    const existing = time.querySelector('.msg-ticks');
    if (existing) existing.outerHTML = ticks;
    else time.insertAdjacentHTML('beforeend', ticks);
  });
  if (!data.isLatest || !data.chatJid) return;
  const row = (store.chatData || []).find((c) => c.chatJid === data.chatJid);
  if (row) row.lastMessageReceipt = data.receiptStatus;
  document.querySelectorAll('.chat-item').forEach((item) => {
    if (item.dataset.jid !== data.chatJid) return;
    const slot = item.querySelector('.chat-preview-ticks');
    if (slot) slot.innerHTML = ticks;
  });
}

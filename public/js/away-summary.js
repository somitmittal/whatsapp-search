import { store } from './store.js';
import { messageTimestampToDate } from './format.js';
import { $, esc } from './util.js';

function awaySummaryDismissKey(jid, sinceTs) {
  return `away_summary_dismissed:${jid}:${sinceTs || 0}`;
}

function isAwaySummaryDismissed(jid, sinceTs) {
  try { return localStorage.getItem(awaySummaryDismissKey(jid, sinceTs)) === '1'; }
  catch { return false; }
}

export function hideAwaySummaryBar() {
  const wrap = $('#away-summary-bar');
  if (!wrap) return;
  wrap.classList.remove('is-visible');
  wrap.style.display = 'none';
}

function showAwaySummaryBar() {
  const wrap = $('#away-summary-bar');
  if (!wrap) return;
  wrap.classList.add('is-visible');
  wrap.style.display = 'block';
}

function dismissAwaySummaryForChat(jid, sinceTs) {
  try { localStorage.setItem(awaySummaryDismissKey(jid, sinceTs), '1'); } catch { /* ignore */ }
  store.awaySummarySnapshot = null;
  hideAwaySummaryBar();
  // Persist dismiss cursor on the server so reopen doesn't immediately re-show.
  if (jid) {
    fetch(`/api/chats/${encodeURIComponent(jid)}/catchup-dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts: Math.floor(Date.now() / 1000) }),
    }).catch(() => {});
  }
}

function isCatchupEligibleJid(jid) {
  if (!jid) return false;
  if (jid.endsWith('@imported') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return false;
  return jid.endsWith('@g.us')
    || jid.endsWith('@s.whatsapp.net')
    || jid.endsWith('@lid')
    || jid.endsWith('@hosted');
}

export async function loadAwaySummaryForChat(jid, snapshot = null) {
  const wrap = $('#away-summary-bar');
  const body = $('#away-summary-body');
  const sum = $('#away-summary-summary');
  const det = $('#away-summary-details');
  if (!wrap || !body) return;
  // Allow during SYNCING — unread catch-up should not wait for history to finish.
  if (!isCatchupEligibleJid(jid) || (store._waState !== 'READY' && store._waState !== 'SYNCING')) {
    store.awaySummarySnapshot = null;
    hideAwaySummaryBar();
    return;
  }
  try {
    const params = new URLSearchParams({ limit: '3' });
    if (snapshot?.unreadCount != null && Number(snapshot.unreadCount) > 10) {
      params.set('unreadCount', String(snapshot.unreadCount));
      if (snapshot.sinceTs != null) params.set('since', String(snapshot.sinceTs));
    }
    const data = await fetch(
      `/api/chats/${encodeURIComponent(jid)}/away-summary?${params.toString()}`,
    ).then((r) => r.json());
    if (store.activeChat !== jid) return;
    if (!data?.eligible || data.unreadCount <= 10) {
      store.awaySummarySnapshot = null;
      hideAwaySummaryBar();
      return;
    }
    if (isAwaySummaryDismissed(jid, data.sinceTs)) {
      store.awaySummarySnapshot = null;
      hideAwaySummaryBar();
      return;
    }

    store.awaySummarySnapshot = {
      jid,
      sinceTs: data.sinceTs,
      unreadCount: data.unreadCount,
      lastThreadsDone: snapshot?.lastThreadsDone || 0,
    };
    const rows = data?.summaries || [];
    showAwaySummaryBar();
    if (sum) sum.textContent = `While you were away · ${data.unreadCount} unseen`;
    if (!rows.length) {
      body.innerHTML = '<div class="away-summary-loading">Creating a summary of the latest discussion… You can keep reading while AI indexing catches up.</div>';
      if (det) det.open = true;
      return;
    }
    body.innerHTML = rows.map((r) => {
      const when = r.threadEnd
        ? (messageTimestampToDate(r.threadEnd)?.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) || 'Unknown date')
        : '';
      const s = (r.summary || '').trim();
      return `<div class="ai-group">
          <div class="ai-group-title">${when ? esc(when) + ' — ' : ''}Summary</div>
          <ul><li>${esc(s)}</li></ul>
        </div>`;
    }).join('');
    if (det) det.open = true;
  } catch {
    store.awaySummarySnapshot = null;
    hideAwaySummaryBar();
  }
}

export function initAwaySummary() {
  $('#away-summary-dismiss')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const jid = store.activeChat || store.awaySummarySnapshot?.jid;
    if (!jid) return;
    dismissAwaySummaryForChat(jid, store.awaySummarySnapshot?.sinceTs);
  });
}

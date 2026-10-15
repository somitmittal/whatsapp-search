import { store } from './store.js';
import { isSmbBusinessMode, smbSearchPlaceholder } from './business.js';
import { openChat } from './chat-view.js';
import { messageTimestampToDate } from './format.js';
import { switchPanel } from './overlays.js';
import { $, esc, escAttr } from './util.js';

export function clearSearch() {
  store.searchActive = false;
  const qEl = $('#q');
  qEl.value = '';
  qEl.placeholder = smbSearchPlaceholder();
  $('#q-media').value = '';
  $('#q-clear').classList.remove('visible');
  $('#search-results').innerHTML = '';
  $('#search-loading').classList.remove('visible');
}

export async function doSearch() {
  const query = $('#q').value.trim();
  if (!query) return;
  const chatJid = store.activeChat || null;
  const mediaType = $('#q-media').value || null;
  store.searchActive = true;
  $('#q-btn').disabled = true;
  $('#q-clear').classList.add('visible');
  $('#search-results').innerHTML = '';
  $('#search-panel-title').textContent = `"${query.slice(0, 40)}${query.length > 40 ? '…' : ''}"`;
  switchPanel();
  $('#search-loading').classList.add('visible');
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (window.SearchableAccount) Object.assign(headers, window.SearchableAccount.authHeaders());
    const installId = window.SearchableAccount ? window.SearchableAccount.getInstallId() : undefined;
    const res = await fetch('/api/search', {
      method: 'POST', headers,
      body: JSON.stringify({
        query,
        chatJid,
        mediaType,
        businessContext: store.sidebarListTab === 'business' && isSmbBusinessMode(),
        installId,
      }),
    });
    const data = await res.json();
    if (res.status === 402 || data.code === 'trial_expired' || data.code === 'account_required') {
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
    } else if (data.error) {
      $('#search-results').innerHTML = `<div style="text-align:center;padding:60px;color:var(--danger)">${esc(data.error)}</div>`;
    } else {
      if (window.SearchableAccount) {
        window.SearchableAccount.track(window.__searchableAppConfig || {}, 'ai_search_run', {});
      }
      renderSearch(data, query, chatJid);
    }
  } catch (err) {
    $('#search-results').innerHTML = `<div style="text-align:center;padding:60px;color:var(--danger)">${esc(err.message)}</div>`;
  } finally {
    $('#q-btn').disabled = false;
    $('#search-loading').classList.remove('visible');
  }
}

function renderSearch(data, query, chatJid) {
  let html = '';
  const scope = chatJid ? (store.chatData.find(c => c.chatJid === chatJid)?.chatName || 'this chat') : 'all chats';
  const srcCount = data.sources?.length || 0;
  $('#search-panel-title').textContent = `"${query.slice(0, 35)}${query.length > 35 ? '…' : ''}"`;
  html += `<div class="sr-header"><span style="font-size:11px;color:var(--text2)">${srcCount} source${srcCount !== 1 ? 's' : ''} · ${esc(scope)}</span></div>`;
  if (data.answer) html += `<div class="answer-card">${formatAnswer(data.answer)}</div>`;
  if (data.sources?.length) {
    html += '<div class="sources"><h4>Sources</h4>';
    const seen = new Set();
    for (const s of data.sources) {
      const k = `${s.chatName}|${s.sender}|${s.timestamp}`;
      if (seen.has(k)) continue; seen.add(k);
      const sourceDate = messageTimestampToDate(s.timestamp);
      const ts = sourceDate ? sourceDate.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) : 'Unknown date';
      const canJump = s.chatJid && s.messageId;
      const dis = canJump ? '' : ' src-disabled';
      const title = canJump ? 'View in chat' : 'Open the chat from the sidebar to jump (missing id)';
      const dChat = s.chatJid ? ` data-chat-jid="${escAttr(s.chatJid)}"` : '';
      const dMid = s.messageId ? ` data-message-id="${escAttr(s.messageId)}"` : '';
      html += `<div class="src-item${dis}"${dChat}${dMid} title="${escAttr(title)}"><div class="meta">${esc(s.chatName || '')} &bull; ${esc(s.sender || '')} &bull; ${esc(ts)}</div><div>${esc((s.text || '').slice(0, 250))}</div></div>`;
    }
    html += '</div>';
  }
  if (!data.answer && !srcCount) html += '<div style="text-align:center;padding:60px;color:var(--text2)">No results found.</div>';
  $('#search-results').innerHTML = html;
}

function formatAnswer(t) {
  let s = esc(t);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  return s;
}

export function initSearch() {
  $('#q-btn').addEventListener('click', doSearch);
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  $('#q-clear').addEventListener('click', () => { clearSearch(); switchPanel(); });
  $('#btn-close-search').addEventListener('click', () => { clearSearch(); switchPanel(); });

  document.getElementById('btn-chat-ai-search')?.addEventListener('click', () => {
    if (!store.activeChat) return;
    const qEl = $('#q');
    qEl.placeholder = 'Ask AI about this chat…';
    qEl.focus();
    try { qEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* */ }
  });

  $('#search-results').addEventListener('click', (e) => {
    const item = e.target.closest('.src-item');
    if (!item || item.classList.contains('src-disabled')) return;
    const jid = item.getAttribute('data-chat-jid');
    const mid = item.getAttribute('data-message-id');
    if (!jid || !mid) return;
    e.preventDefault();
    void openChat(jid, mid);
  });
}

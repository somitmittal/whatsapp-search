import { esc, escAttr } from './util.js';
import { postWaReaction } from './messages-render.js';

const AVATAR_COLORS = [
  '#00a884',
  '#1f71eb',
  '#df3750',
  '#8c5383',
  '#d97706',
  '#0284c7',
  '#059669',
  '#7c3aed',
  '#db2777',
  '#0d9488',
];

function getAvatarColor(str) {
  if (!str) return AVATAR_COLORS[0];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getAvatarInitials(name) {
  const n = String(name || '').trim();
  if (!n) return '?';
  if (n.toLowerCase() === 'you') return 'Y';
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return n.slice(0, 1).toUpperCase();
}

let activeModalState = null;

const reactionDetailsCache = new Map();
const REACTION_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 120;

export function invalidateReactionDetailsCache(chatJid, messageId) {
  if (!messageId) return;
  const m = String(messageId);
  if (chatJid) reactionDetailsCache.delete(`${chatJid}\0${m}`);
  reactionDetailsCache.delete(`\0${m}`);
  // Also clean any keys containing the message id
  for (const k of reactionDetailsCache.keys()) {
    if (k.endsWith(`\0${m}`)) reactionDetailsCache.delete(k);
  }
}

export function cacheReactionDetails(chatJid, messageId, data) {
  if (!messageId || !data) return;
  const key = `${chatJid || ''}\0${messageId}`;
  if (reactionDetailsCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = reactionDetailsCache.keys().next().value;
    reactionDetailsCache.delete(oldest);
  }
  reactionDetailsCache.set(key, { data, ts: Date.now() });
}

function ensureModalElements() {
  let overlay = document.getElementById('wa-reaction-details-modal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'wa-reaction-details-modal';
    overlay.className = 'wa-reaction-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'wa-reaction-modal-title');
    overlay.hidden = true;
    overlay.style.display = 'none';
    overlay.style.pointerEvents = 'none';
    overlay.innerHTML = `
      <div class="wa-reaction-modal-card">
        <div class="wa-reaction-modal-header">
          <div class="wa-reaction-modal-tabs" role="tablist"></div>
          <button type="button" class="wa-reaction-modal-close" aria-label="Close dialog">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
        <div class="wa-reaction-modal-body">
          <div class="wa-reactor-list"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('.wa-reaction-modal-close')) {
        closeReactionDetailsModal();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) {
        closeReactionDetailsModal();
      }
    });
  }
  return overlay;
}

export function closeReactionDetailsModal() {
  const overlay = document.getElementById('wa-reaction-details-modal');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.hidden = true;
    overlay.style.display = 'none';
    overlay.style.pointerEvents = 'none';
  }
  activeModalState = null;
}

function renderModalContent(overlay, data, selectedEmoji = 'all') {
  const tabsWrap = overlay.querySelector('.wa-reaction-modal-tabs');
  const listWrap = overlay.querySelector('.wa-reactor-list');
  if (!tabsWrap || !listWrap) return;

  const reactions = Array.isArray(data?.reactions) ? data.reactions : [];
  const counts = (data?.counts && typeof data.counts === 'object') ? data.counts : {};

  if (!reactions.length) {
    tabsWrap.innerHTML = '<span class="wa-reaction-tab active">No reactions</span>';
    listWrap.innerHTML = '<div class="wa-reaction-modal-empty">No reactions for this message.</div>';
    return;
  }

  const sortedEmojis = Object.entries(counts)
    .filter(([, c]) => Number(c) > 0)
    .sort((a, b) => b[1] - a[1]);

  const totalCount = sortedEmojis.reduce((acc, [, c]) => acc + Number(c), 0) || reactions.length;

  let activeTab = selectedEmoji;
  if (activeTab !== 'all' && !counts[activeTab]) {
    activeTab = 'all';
  }

  // Render tabs
  let tabsHtml = `
    <button type="button" class="wa-reaction-tab ${activeTab === 'all' ? 'active' : ''}" data-tab-emoji="all" role="tab" aria-selected="${activeTab === 'all'}">
      All <span class="tab-count">${totalCount}</span>
    </button>
  `;

  for (const [em, cnt] of sortedEmojis) {
    const isAct = activeTab === em;
    tabsHtml += `
      <button type="button" class="wa-reaction-tab ${isAct ? 'active' : ''}" data-tab-emoji="${escAttr(em)}" role="tab" aria-selected="${isAct}">
        ${esc(em)} <span class="tab-count">${cnt}</span>
      </button>
    `;
  }
  tabsWrap.innerHTML = tabsHtml;

  // Filter reactions
  const visible = activeTab === 'all'
    ? reactions
    : reactions.filter((r) => r.emoji === activeTab);

  if (!visible.length) {
    listWrap.innerHTML = '<div class="wa-reaction-modal-empty">No reactions for this emoji.</div>';
    return;
  }

  // Render reactor list
  listWrap.innerHTML = visible.map((r) => {
    const isSelf = Boolean(r.fromMe);
    const name = isSelf ? 'You' : (r.sender || 'Participant');
    const color = isSelf ? '#00a884' : getAvatarColor(r.senderJid || name);
    const initials = getAvatarInitials(name);
    const hint = isSelf
      ? '<div class="wa-reactor-sub is-removable">Click to remove</div>'
      : (r.senderJid && r.senderJid.includes('@') && !r.senderJid.includes('@g.us') ? `<div class="wa-reactor-sub">${esc(r.senderJid.split('@')[0])}</div>` : '');

    return `
      <div class="wa-reactor-item ${isSelf ? 'is-self' : ''}" data-from-me="${isSelf ? '1' : '0'}" data-emoji="${escAttr(r.emoji)}" ${isSelf ? 'title="Click to remove your reaction"' : ''} role="button" tabindex="${isSelf ? '0' : '-1'}">
        <div class="wa-reactor-avatar" style="background-color: ${color}">
          <span>${esc(initials)}</span>
        </div>
        <div class="wa-reactor-info">
          <div class="wa-reactor-name">${esc(name)}</div>
          ${hint}
        </div>
        <div class="wa-reactor-emoji">${esc(r.emoji)}</div>
      </div>
    `;
  }).join('');

  // Wire tab clicks
  tabsWrap.querySelectorAll('.wa-reaction-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const em = tabBtn.getAttribute('data-tab-emoji') || 'all';
      renderModalContent(overlay, data, em);
    });
  });

  // Wire self reaction removal
  listWrap.querySelectorAll('.wa-reactor-item.is-self').forEach((selfItem) => {
    const handleRemove = async (e) => {
      e.stopPropagation();
      if (!activeModalState) return;
      const { chatJid, messageId } = activeModalState;
      invalidateReactionDetailsCache(chatJid, messageId);
      closeReactionDetailsModal();
      try {
        await postWaReaction(chatJid, messageId, '');
      } catch (err) {
        console.warn('[WA] remove reaction failed:', err.message);
      }
    };
    selfItem.addEventListener('click', handleRemove);
    selfItem.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleRemove(e);
      }
    });
  });
}

/**
 * Open the WhatsApp-style reaction details dialog.
 * @param {{ chatJid: string, messageId: string, initialEmoji?: string }} options
 */
export async function openReactionDetailsModal({ chatJid, messageId, initialEmoji = '' }) {
  if (!messageId) return;

  const overlay = ensureModalElements();
  activeModalState = { chatJid, messageId };

  overlay.hidden = false;
  overlay.style.display = 'flex';
  overlay.style.pointerEvents = 'auto';
  overlay.classList.add('open');

  const cacheKey = `${chatJid || ''}\0${messageId}`;
  const cached = reactionDetailsCache.get(cacheKey) || reactionDetailsCache.get(`\0${messageId}`);
  const isFresh = Boolean(cached && (Date.now() - cached.ts < REACTION_CACHE_TTL_MS));

  if (isFresh && cached.data) {
    // Instant zero-latency render from memory cache
    renderModalContent(overlay, cached.data, initialEmoji || 'all');
  } else {
    const tabsWrap = overlay.querySelector('.wa-reaction-modal-tabs');
    const listWrap = overlay.querySelector('.wa-reactor-list');
    if (tabsWrap) tabsWrap.innerHTML = '<span class="wa-reaction-tab active">Reactions</span>';
    if (listWrap) listWrap.innerHTML = '<div class="wa-reaction-modal-loading">Loading reactions…</div>';
  }

  try {
    const res = await fetch(`/api/wa/reactions?chatJid=${encodeURIComponent(chatJid || '')}&messageId=${encodeURIComponent(messageId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cacheReactionDetails(chatJid, messageId, data);
    if (!overlay.classList.contains('open') || activeModalState?.messageId !== messageId) {
      return; // Closed or navigated while fetching
    }
    renderModalContent(overlay, data, initialEmoji || 'all');
  } catch (err) {
    if (!isFresh) {
      console.warn('[WA] openReactionDetailsModal error:', err.message);
      if (overlay.classList.contains('open')) {
        const listWrap = overlay.querySelector('.wa-reactor-list');
        if (listWrap) listWrap.innerHTML = `<div class="wa-reaction-modal-empty">Failed to load reactions: ${esc(err.message)}</div>`;
      }
    }
  }
}

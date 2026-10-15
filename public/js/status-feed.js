import { store } from './store.js';
import { closeAvatarViewer } from './avatars.js';
import { messageTimestampToDate } from './format.js';
import { mediaDownloadUrl, mediaUrlForMessage } from './media.js';
import { postWaReaction } from './messages-render.js';
import { $, esc, escAttr } from './util.js';
import { isWaUiReady } from './wa-connection.js';

export async function refreshStatusFeed() {
  try {
    const data = await fetch('/api/wa/status-feed').then((r) => r.json());
    store.statusFeedData = data && Array.isArray(data.peers) ? data : { peers: [] };
  } catch {
    store.statusFeedData = { peers: [] };
  }
  renderStatusStrip();
}

export function renderStatusStrip() {
  const wrap = $('#status-strip-wrap');
  const strip = $('#status-strip');
  if (!wrap || !strip) return;
  const show = store.sidebarListTab === 'feed' && isWaUiReady();
  const peers = store.statusFeedData.peers || [];
  if (!show || peers.length === 0) {
    wrap.hidden = true;
    strip.innerHTML = '';
    return;
  }
  wrap.hidden = false;
  strip.innerHTML = peers.map((p, idx) => {
    const letter = (p.displayName || '?').charAt(0).toUpperCase();
    const prevId = p.previewMessageId;
    const hasThumb = prevId && p.hasMediaFile && ['image', 'video', 'sticker'].includes(p.previewMediaType);
    const thumb = hasThumb
      ? `<img src="${escAttr(mediaUrlForMessage(prevId))}" alt="" loading="lazy">`
      : `<span class="status-strip-letter">${esc(letter)}</span>`;
    const ringCls = (p.items && p.items.length) ? ' has-items' : '';
    const label = (p.displayName || 'Status').slice(0, 14);
    return `<div class="status-strip-item${ringCls}" role="listitem">
        <button type="button" class="status-strip-btn" data-peer-idx="${idx}" aria-label="${escAttr(p.displayName || 'Status')}">
          <span class="status-strip-ring"><span class="status-strip-inner">${thumb}</span></span>
          <span class="status-strip-name">${esc(label)}</span>
        </button>
      </div>`;
  }).join('');
  strip.querySelectorAll('.status-strip-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = parseInt(btn.getAttribute('data-peer-idx'), 10);
      if (!Number.isNaN(i)) openStatusViewer(i);
    });
  });
}

function closeStatusViewer() {
  store.currentStatusSlideMessageId = null;
  const ov = $('#status-viewer');
  if (ov) {
    ov.hidden = true;
    ov.classList.remove('open');
    ov.setAttribute('aria-hidden', 'true');
  }
  const stage = $('#status-viewer-stage');
  if (stage) {
    stage.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch (_) {} });
    stage.innerHTML = '';
  }
  const rx = $('#status-viewer-rx');
  if (rx) rx.style.display = 'none';
  const svd = $('#status-viewer-download');
  if (svd) {
    svd.hidden = true;
    svd.removeAttribute('href');
  }
}

function renderStatusViewerSlide() {
  const peers = store.statusFeedData.peers || [];
  let { peerIdx, itemIdx } = store.statusViewerState;
  const peer = peers[peerIdx];
  if (!peer) {
    closeStatusViewer();
    return;
  }
  const items = peer.items || [];
  const item = items[itemIdx];
  if (!item) {
    closeStatusViewer();
    return;
  }
  const titleEl = $('#status-viewer-title');
  const metaEl = $('#status-viewer-meta');
  const stage = $('#status-viewer-stage');
  if (titleEl) titleEl.textContent = peer.displayName || '';
  if (metaEl) {
    const itemDate = messageTimestampToDate(item.timestamp);
    metaEl.textContent = `${itemIdx + 1} / ${items.length} · ${itemDate ? itemDate.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unknown date'}`;
  }
  if (!stage) return;
  store.currentStatusSlideMessageId = item.messageId || null;
  const rx = $('#status-viewer-rx');
  if (rx) rx.style.display = store.currentStatusSlideMessageId ? 'flex' : 'none';
  const svd = $('#status-viewer-download');
  stage.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch (_) {} });
  const mid = item.messageId;
  const url = item.hasMediaFile ? mediaUrlForMessage(mid) : '';
  if (svd) {
    if (url && mid) {
      svd.href = mediaDownloadUrl(mid);
      svd.hidden = false;
    } else {
      svd.hidden = true;
      svd.removeAttribute('href');
    }
  }
  let inner = '';
  if (url && (item.mediaType === 'image' || item.mediaType === 'sticker')) {
    inner = `<img class="status-slide-img" src="${escAttr(url)}" alt="">`;
  } else if (url && item.mediaType === 'video') {
    inner = `<video class="status-slide-vid" src="${escAttr(url)}" controls playsinline autoplay></video>`;
  } else if (url && item.mediaType === 'audio') {
    inner = `<audio class="status-slide-audio" src="${escAttr(url)}" controls autoplay></audio>`;
  } else {
    const t = (item.text || item.mediaCaption || '').trim() || '(No preview)';
    inner = `<div class="status-slide-text">${esc(t)}</div>`;
  }
  stage.innerHTML = inner;
}

function statusViewerNext() {
  const peers = store.statusFeedData.peers || [];
  let { peerIdx, itemIdx } = store.statusViewerState;
  const peer = peers[peerIdx];
  if (!peer) {
    closeStatusViewer();
    return;
  }
  const items = peer.items || [];
  if (itemIdx < items.length - 1) {
    store.statusViewerState = { peerIdx, itemIdx: itemIdx + 1 };
  } else if (peerIdx < peers.length - 1) {
    store.statusViewerState = { peerIdx: peerIdx + 1, itemIdx: 0 };
  } else {
    closeStatusViewer();
    return;
  }
  renderStatusViewerSlide();
}

function statusViewerPrev() {
  const peers = store.statusFeedData.peers || [];
  let { peerIdx, itemIdx } = store.statusViewerState;
  if (itemIdx > 0) {
    store.statusViewerState = { peerIdx, itemIdx: itemIdx - 1 };
  } else if (peerIdx > 0) {
    const prevPeer = peers[peerIdx - 1];
    const prevItems = prevPeer?.items || [];
    store.statusViewerState = { peerIdx: peerIdx - 1, itemIdx: Math.max(0, prevItems.length - 1) };
  } else {
    closeStatusViewer();
    return;
  }
  renderStatusViewerSlide();
}

function openStatusViewer(peerIdx) {
  const peers = store.statusFeedData.peers || [];
  if (!peers[peerIdx]) return;
  store.statusViewerState = { peerIdx, itemIdx: 0 };
  const ov = $('#status-viewer');
  if (!ov) return;
  ov.hidden = false;
  ov.classList.add('open');
  ov.setAttribute('aria-hidden', 'false');
  renderStatusViewerSlide();
}

export function initStatusFeed() {
  $('#status-viewer-close')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeStatusViewer();
  });

  $('#status-hit-prev')?.addEventListener('click', (e) => { e.stopPropagation(); statusViewerPrev(); });
  $('#status-hit-next')?.addEventListener('click', (e) => { e.stopPropagation(); statusViewerNext(); });

  document.addEventListener('keydown', (e) => {
    const avOv = $('#avatar-viewer');
    if (avOv && !avOv.hidden && e.key === 'Escape') {
      e.preventDefault();
      closeAvatarViewer();
      return;
    }
    const ov = $('#status-viewer');
    if (!ov || ov.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeStatusViewer();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      statusViewerNext();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      statusViewerPrev();
    }
  });

  $('#status-viewer-rx')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-wa-react-st]');
    if (!b || !store.currentStatusSlideMessageId) return;
    e.stopPropagation();
    try {
      await postWaReaction('status@broadcast', store.currentStatusSlideMessageId, b.getAttribute('data-wa-react-st') || '👍');
    } catch (err) {
      alert(err.message || 'Reaction failed');
    }
  });
}

import { store } from './store.js';
import { canSendMessageToJid } from './composer.js';
import { dateFmt, formatChatBubbleDateTime, formatChatDateSeparator, messageTimestampToDate, receiptTicksHtml } from './format.js';
import { mediaDownloadUrl, mediaUrlForMessage, messageMediaDownloadAnchor } from './media.js';
import { $, esc, escAttr, hash } from './util.js';
import { setupReactionSearch } from './emoji-picker.js';
import { getRecentEmojis, recordRecentEmoji } from './emoji-data.js';
import { invalidateReactionDetailsCache } from './reaction-details-modal.js';

let imageViewerEl = null;
/** WhatsApp Web icon paths for the message menu (mirror of WA's own icons). */
const WA_ICONS = {
  chevron: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M12 15.5 6.6 10.1 8 8.7l4 4 4-4 1.4 1.4z"/></svg>',
  reply: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M10 8.5V13a1 1 0 0 1-1.7.71l-4.6-4.6a1 1 0 0 1 0-1.41l4.6-4.6A1 1 0 0 1 10 3.8V5.5c5.6.3 9.7 3.7 10.9 9.1.4 1.7.2 3-.2 4.3-.2.6-1 .7-1.4.2-2.4-3.4-5.4-5.6-9.3-6.3z"/></svg>',
  forward: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M14 8.5V13a1 1 0 0 0 1.7.71l4.6-4.6a1 1 0 0 0 0-1.41l-4.6-4.6A1 1 0 0 0 14 3.8V5.5C8.4 5.8 4.3 9.2 3.1 14.6c-.4 1.7-.2 3 .2 4.3.2.6 1 .7 1.4.2 2.4-3.4 5.4-5.6 9.3-6.3z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M14.1 6.3 17.7 9.9 9 18.6l-3.4.7a.7.7 0 0 1-.8-.8l.7-3.4 8.6-8.8zm1.4-1.4a1.6 1.6 0 0 0-2.3 0l-8.8 9a1.6 1.6 0 0 0-.43.8l-.77 3.9a1.7 1.7 0 0 0 2 2l3.9-.77c.3-.1.6-.24.8-.43l9-8.8a1.6 1.6 0 0 0 0-2.3l-3.4-3.4z"/></svg>',
  delete: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M9.5 4h5a1 1 0 0 1 1 1v.5H19a1 1 0 1 1 0 2h-.6l-.7 10.6A2.5 2.5 0 0 1 15.2 20.5H8.8a2.5 2.5 0 0 1-2.5-2.4L5.6 7.5H5a1 1 0 1 1 0-2h3.5V5a1 1 0 0 1 1-1zm.5 2h4v-.5h-4V6zm-3.3 1.5.6 10.75c.03.55.48.75 1 .75h6.4c.52 0 .97-.2 1-.75l.6-10.75H6.7zM10 9.5a.75.75 0 0 1 .75.75v6a.75.75 0 1 1-1.5 0v-6A.75.75 0 0 1 10 9.5zm4 0a.75.75 0 0 1 .75.75v6a.75.75 0 1 1-1.5 0v-6A.75.75 0 0 1 14 9.5z"/></svg>',
  react: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM1.5 12C1.5 6.2 6.2 1.5 12 1.5S22.5 6.2 22.5 12 17.8 22.5 12 22.5 1.5 17.8 1.5 12zM8.4 7.6a4 4 0 0 1 2.9 1.1 1 1 0 1 1-1.3 1.4 2 2 0 0 0-2.9 0L5.7 8.7a4 4 0 0 1 2.7-1.1zm7.2 0a4 4 0 0 1 2.7 1.1l-1.4 1.4a2 2 0 0 0-2.9 0 1 1 0 1 1-1.3-1.4 4 4 0 0 1 2.9-1.1z"/><path d="M12 13.2c2.2 0 4 1.4 4 3.1 0 .9-.5 1.7-1.2 2.2a1 1 0 0 1-.8.1 6.6 6.6 0 0 0-4 0 1 1 0 0 1-.8-.1c-.7-.5-1.2-1.3-1.2-2.2 0-1.7 1.8-3.1 4-3.1z"/></svg>',
};
const WA_REACTION_QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const MORE_REACTION_EMOJIS = [
  '😀','😃','😄','😁','😆','😅','😂','🤣','🥲','😊','😇','🙂','🙃','😉','😍','🥰',
  '😘','😗','😋','😛','🤪','😎','🤩','🥳','😏','😔','😟','😢','😭','😤','😡','🤔',
  '🫡','🤗','🤫','🤭','🫣','🤥','😴','🤒','🤧','🥺','😱','😮','😲','😳','🤯','🥶',
  '👍','👎','👏','🙌','👐','🤝','🙏','💪','🫶','👋','✌️','🤞','🤟','👌','🤌','🤘',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','❣️','💕','💞','💓','💗','💖','💘',
  '🔥','🎉','💯','✨','⭐','🌟','💥','💫','🎊','✅','❌','⚠️','💡','🎂','🍕','☕',
  '🐶','🐱','🐼','🦁','🐸','🦄','🌈','☀️','🌹','🌻','🍀','⚽','🏆','🚀','💰','📈',
];

export function toggleReactionEmojiPicker(button) {
  const block = button?.closest('.msg-block');
  const picker = block?.querySelector('.wa-reaction-picker');
  if (!picker) return;
  const shouldOpen = picker.hidden;
  closeReactionEmojiPickers();
  closeMessageMenus();
  if (shouldOpen && !picker.dataset.ready) {
    const recents = getRecentEmojis();
    const quickFavorites = [...new Set([...(recents.slice(0, 6)), ...WA_REACTION_QUICK])].slice(0, 6);
    // WhatsApp's react sheet: search bar, quick reactions first, then the full grid.
    picker.innerHTML = `
      <div class="wa-reaction-search-wrap">
        <svg class="wa-emoji-search-icon" viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <path d="M10 2a8 8 0 0 1 6.32 12.906l4.387 4.387a1 1 0 0 1-1.414 1.414l-4.387-4.387A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z"/>
        </svg>
        <input type="text" class="wa-reaction-search-input" placeholder="Search emoji" autocomplete="off" />
      </div>
      <div class="wa-picker-quick">`
      + quickFavorites.map((emoji) =>
        `<button type="button" class="wa-tb" data-wa-react="${escAttr(emoji)}" title="React ${escAttr(emoji)}" aria-label="React ${escAttr(emoji)}">${esc(emoji)}</button>`).join('')
      + `<button type="button" class="wa-tb wa-tb-remove-reaction" data-wa-react="" title="Remove your reaction" aria-label="Remove your reaction">-</button>`
      + `</div>`
      + `<div class="wa-picker-grid">`
      + MORE_REACTION_EMOJIS.map((emoji) =>
        `<button type="button" class="wa-tb" data-wa-react="${escAttr(emoji)}" title="React ${escAttr(emoji)}" aria-label="React ${escAttr(emoji)}">${esc(emoji)}</button>`).join('')
      + `</div>`;
    picker.dataset.ready = '1';
    setupReactionSearch(picker);
  }
  picker.hidden = !shouldOpen;
  if (shouldOpen) {
    const rect = button?.getBoundingClientRect?.();
    if (rect && rect.top < 280) {
      picker.style.bottom = 'auto';
      picker.style.top = 'calc(100% + 4px)';
    } else {
      picker.style.top = 'auto';
      picker.style.bottom = 'calc(100% + 4px)';
    }
    if (rect && typeof window !== 'undefined') {
      if (rect.left + 310 > window.innerWidth) {
        picker.style.left = 'auto';
        picker.style.right = '0';
      } else if (rect.right - 310 < 0) {
        picker.style.right = 'auto';
        picker.style.left = '0';
      }
    }
    const searchInput = picker.querySelector('.wa-reaction-search-input');
    if (searchInput) {
      searchInput.value = '';
      setTimeout(() => searchInput.focus(), 40);
    }
  }
}

export function closeReactionEmojiPickers() {
  document.querySelectorAll('.wa-reaction-picker:not([hidden])').forEach((picker) => { picker.hidden = true; });
}

/** The WhatsApp-style ▾ dropdown (Reply / React / Forward / Edit / Delete). */
export function toggleMessageMenu(button) {
  const menu = button?.closest('.bubble-toolbar')?.querySelector('.wa-msg-menu');
  if (!menu) return;
  const shouldOpen = menu.hidden;
  closeReactionEmojiPickers();
  closeMessageMenus();
  menu.hidden = !shouldOpen;
}

export function closeMessageMenus() {
  document.querySelectorAll('.wa-msg-menu:not([hidden])').forEach((menu) => { menu.hidden = true; });
}

/** Extracts canonical plain text to copy from a message model. */
export function extractMessageCopyText(m) {
  if (!m) return '';
  if (m.contactPayload) {
    try {
      const p = typeof m.contactPayload === 'string' ? JSON.parse(m.contactPayload) : m.contactPayload;
      if (p?.contacts?.length) {
        const lines = [];
        for (const c of p.contacts) {
          const name = (c.displayName || '').trim();
          if (name) lines.push(name);
          if (c.organization) lines.push(`Org: ${c.organization}`);
          for (const ph of c.phones || []) {
            const rawPh = String(ph || '').trim();
            if (rawPh) lines.push(`Phone: ${rawPh}`);
          }
          for (const em of c.emails || []) {
            const rawEm = String(em || '').trim();
            if (rawEm) lines.push(`Email: ${rawEm}`);
          }
        }
        if (lines.length) return lines.join('\n');
      }
    } catch (_) {}
  }
  const text = (m.text != null ? String(m.text) : '').trim();
  const cap = (m.mediaCaption != null ? String(m.mediaCaption) : '').trim();
  if (text && cap && text !== cap) {
    return `${cap}\n${text}`;
  }
  if (text) return text;
  if (cap) return cap;
  if (m.mediaType) return `[${m.mediaType}]`;
  return '';
}

/** Resolves copyable text for a message block from button attribute or rendered DOM fallback. */
export function getMessageBlockCopyText(block, copyBtn = null) {
  if (copyBtn && copyBtn.hasAttribute('data-copy-text')) {
    const raw = copyBtn.getAttribute('data-copy-text');
    if (raw !== null && raw !== '') return raw;
  }
  if (!block) return '';
  const bubble = block.querySelector?.('.bubble') || block;
  const textEl = bubble.querySelector?.('.text');
  if (textEl && textEl.innerText?.trim()) return textEl.innerText.trim();
  const capEl = bubble.querySelector?.('.media-cap');
  if (capEl && capEl.innerText?.trim()) return capEl.innerText.trim();
  const contactCard = bubble.querySelector?.('.msg-contact-card');
  if (contactCard && contactCard.innerText?.trim()) return contactCard.innerText.trim();
  const docLink = bubble.querySelector?.('.msg-media-doc');
  if (docLink && docLink.innerText?.trim()) return docLink.innerText.trim();
  return '';
}

/** Robust clipboard write with navigator.clipboard and execCommand textarea fallback. */
export async function copyTextToClipboard(text) {
  const content = String(text ?? '');
  if (!content) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
      return true;
    }
  } catch (_) {}
  try {
    if (typeof document !== 'undefined') {
      const ta = document.createElement('textarea');
      ta.value = content;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) return true;
    }
  } catch (_) {}
  return false;
}

/** WhatsApp-style temporary pill toast confirming message copied. */
export function showMessageToast(msg) {
  if (typeof document === 'undefined') return;
  let toast = document.getElementById('wa-message-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'wa-message-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.style.cssText = [
      'position:fixed',
      'bottom:24px',
      'left:50%',
      'transform:translateX(-50%)',
      'background:#1f2c34',
      'color:#e9edef',
      'padding:8px 18px',
      'border-radius:18px',
      'font-size:13px',
      'font-weight:500',
      'box-shadow:0 4px 14px rgba(0,0,0,0.3)',
      'z-index:99999',
      'pointer-events:none',
      'transition:opacity 0.25s ease, transform 0.25s ease',
      'opacity:0',
      'white-space:nowrap',
    ].join(';');
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.transform = 'translateX(-50%) translateY(0)';
  toast.style.opacity = '1';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(6px)';
  }, 2200);
  if (typeof toast._hideTimer?.unref === 'function') {
    toast._hideTimer.unref();
  }
}

/** Shared click handler for [data-wa-copy] buttons. */
export async function handleMessageCopyClick(copyBtn, target = null) {
  const block = target?.closest?.('.msg-block') || copyBtn?.closest?.('.msg-block');
  closeMessageMenus();
  const text = getMessageBlockCopyText(block, copyBtn);
  if (text) {
    await copyTextToClipboard(text);
    showMessageToast('Message copied');
    return true;
  }
  showMessageToast('Nothing to copy');
  return false;
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const copyBtn = event.target?.closest?.('[data-wa-copy]');
    if (copyBtn) {
      void handleMessageCopyClick(copyBtn, event.target);
      return;
    }
    if (event.target?.closest?.('.wa-msg-menu')) closeMessageMenus();
    if (!event.target?.closest?.('.bubble-toolbar, .bubble-reaction-bar, .wa-reaction-picker, [data-wa-emoji-picker-toggle]')) {
      closeReactionEmojiPickers();
      closeMessageMenus();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeReactionEmojiPickers();
      closeMessageMenus();
    }
  });
}

function closeChatImageViewer() {
  if (!imageViewerEl) return;
  imageViewerEl.hidden = true;
  imageViewerEl.setAttribute('aria-hidden', 'true');
  const image = imageViewerEl.querySelector('img');
  if (image) {
    image.removeAttribute('src');
    image.hidden = true;
    image.style.display = 'none';
    image.onerror = null;
  }
  const video = imageViewerEl.querySelector('video');
  if (video) {
    try { video.pause(); } catch { /* ignore */ }
    video.removeAttribute('src');
    video.hidden = true;
    video.style.display = 'none';
    try { video.load(); } catch { /* ignore */ }
  }
  const pdf = imageViewerEl.querySelector('.chat-image-viewer-pdf');
  if (pdf) {
    pdf.removeAttribute('src');
    pdf.hidden = true;
    pdf.style.display = 'none';
  }
}

let _viewerImageZoom = 1;

function applyImageViewerZoom(root, nextZoom) {
  _viewerImageZoom = Math.max(0.5, Math.min(4, Math.round(nextZoom * 100) / 100));
  const image = root?.querySelector?.('img');
  if (image) {
    image.style.transform = _viewerImageZoom === 1 ? '' : `scale(${_viewerImageZoom})`;
    image.style.transformOrigin = 'center center';
  }
  const zoomLbl = root?.querySelector?.('.viewer-zoom-level');
  if (zoomLbl) zoomLbl.textContent = `${Math.round(_viewerImageZoom * 100)}%`;
}

function ensureChatMediaViewer() {
  if (imageViewerEl) return imageViewerEl;
  imageViewerEl = document.createElement('div');
  imageViewerEl.className = 'chat-image-viewer';
  imageViewerEl.hidden = true;
  imageViewerEl.setAttribute('role', 'dialog');
  imageViewerEl.setAttribute('aria-modal', 'true');
  imageViewerEl.setAttribute('aria-label', 'Media preview');
  imageViewerEl.innerHTML = '<button class="chat-image-viewer-close" type="button" aria-label="Close">×</button><div class="chat-image-viewer-stage"><img alt="" hidden style="display:none"><video class="chat-image-viewer-video" controls playsinline hidden style="display:none"></video><iframe class="chat-image-viewer-pdf" title="PDF preview" hidden style="display:none"></iframe></div><div class="chat-image-viewer-caption"></div>';
  document.body.appendChild(imageViewerEl);
  imageViewerEl.addEventListener('click', (event) => {
    const zoomBtn = event.target.closest('[data-viewer-zoom]');
    if (zoomBtn) {
      event.stopPropagation();
      const op = zoomBtn.getAttribute('data-viewer-zoom');
      if (op === 'in') applyImageViewerZoom(imageViewerEl, _viewerImageZoom + 0.25);
      else if (op === 'out') applyImageViewerZoom(imageViewerEl, _viewerImageZoom - 0.25);
      else applyImageViewerZoom(imageViewerEl, 1);
      return;
    }
    if (
      event.target === imageViewerEl
      || event.target.classList.contains('chat-image-viewer-stage')
      || event.target.closest('.chat-image-viewer-close')
    ) {
      closeChatImageViewer();
    }
  });
  imageViewerEl.querySelector('.chat-image-viewer-stage')?.addEventListener('wheel', (event) => {
    const image = imageViewerEl?.querySelector('img');
    if (!image || image.hidden || image.style.display === 'none') return;
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.15 : -0.15;
    applyImageViewerZoom(imageViewerEl, _viewerImageZoom + delta);
  }, { passive: false });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && imageViewerEl && !imageViewerEl.hidden) closeChatImageViewer();
  });
  return imageViewerEl;
}

export function openChatImageViewer(source, alt = '', caption = '') {
  if (String(source || '').toLowerCase().includes('.pdf') || String(alt || '').toLowerCase().includes('pdf')) {
    openChatPdfViewer(source, caption || alt);
    return;
  }
  const root = ensureChatMediaViewer();
  applyImageViewerZoom(root, 1);
  const image = root.querySelector('img');
  const video = root.querySelector('video');
  const pdf = root.querySelector('.chat-image-viewer-pdf');
  if (video) {
    try { video.pause(); } catch { /* ignore */ }
    video.hidden = true;
    video.style.display = 'none';
    video.removeAttribute('src');
  }
  if (pdf) {
    pdf.hidden = true;
    pdf.style.display = 'none';
    pdf.removeAttribute('src');
  }
  const captionEl = root.querySelector('.chat-image-viewer-caption');
  if (image) {
    if (source) {
      image.hidden = false;
      image.style.display = 'block';
      image.onerror = () => {
        if (captionEl) captionEl.textContent = `${caption ? caption + ' · ' : ''}Media file is not available locally. View in chat or download from WhatsApp.`;
      };
      image.src = source;
      image.alt = alt || 'Chat image';
    } else {
      image.hidden = true;
      image.style.display = 'none';
      image.removeAttribute('src');
      if (captionEl) captionEl.textContent = `${caption ? caption + ' · ' : ''}Media file not downloaded. View in chat or download from WhatsApp.`;
    }
  }
  if (captionEl && source) {
    const cleanCap = caption ? `<span class="viewer-cap-text">${esc(caption)}</span>` : '';
    const dlUrl = source.includes('?') ? `${source}&download=1` : `${source}?download=1`;
    captionEl.innerHTML = `${cleanCap}<span class="viewer-actions">` +
      `<button type="button" class="viewer-btn" data-viewer-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>` +
      `<span class="viewer-zoom-level">100%</span>` +
      `<button type="button" class="viewer-btn" data-viewer-zoom="in" aria-label="Zoom in" title="Zoom in">+</button>` +
      `<button type="button" class="viewer-btn" data-viewer-zoom="reset" aria-label="Reset zoom" title="Reset zoom">Reset</button>` +
      `<a href="${escAttr(dlUrl)}" download class="viewer-btn" title="Download image">Download ↓</a>` +
      `</span>`;
  }
  root.hidden = false;
  root.setAttribute('aria-hidden', 'false');
}

export function openChatPdfViewer(source, caption = '') {
  const root = ensureChatMediaViewer();
  const image = root.querySelector('img');
  const video = root.querySelector('video');
  const pdf = root.querySelector('.chat-image-viewer-pdf');
  if (image) {
    image.hidden = true;
    image.style.display = 'none';
    image.removeAttribute('src');
    image.onerror = null;
  }
  if (video) {
    try { video.pause(); } catch { /* ignore */ }
    video.hidden = true;
    video.style.display = 'none';
    video.removeAttribute('src');
  }
  const captionEl = root.querySelector('.chat-image-viewer-caption');
  if (pdf) {
    if (source) {
      pdf.hidden = false;
      pdf.style.display = 'block';
      pdf.src = source;
    } else {
      pdf.hidden = true;
      pdf.style.display = 'none';
      pdf.removeAttribute('src');
      if (captionEl) captionEl.textContent = `${caption ? caption + ' · ' : ''}PDF file not downloaded. View in chat or download from WhatsApp.`;
    }
  }
  if (captionEl && source) {
    const cleanCap = esc(caption || 'PDF Document');
    const dlUrl = source.includes('?') ? `${source}&download=1` : `${source}?download=1`;
    captionEl.innerHTML = `<span class="viewer-cap-text">${cleanCap}</span>` +
      `<span class="viewer-actions">` +
      `<a href="${escAttr(source)}" target="_blank" rel="noopener" class="viewer-btn" title="Open in new tab">Open in new tab ↗</a>` +
      `<a href="${escAttr(dlUrl)}" download class="viewer-btn" title="Download PDF">Download ↓</a>` +
      `</span>`;
  }
  root.hidden = false;
  root.setAttribute('aria-hidden', 'false');
}

if (typeof window !== 'undefined') {
  window.openChatImageViewer = openChatImageViewer;
  window.openChatPdfViewer = openChatPdfViewer;
}

function openChatVideoViewer(source, caption = '') {
  const root = ensureChatMediaViewer();
  const image = root.querySelector('img');
  const video = root.querySelector('video');
  const pdf = root.querySelector('.chat-image-viewer-pdf');
  if (image) {
    image.hidden = true;
    image.style.display = 'none';
    image.removeAttribute('src');
    image.onerror = null;
  }
  if (pdf) {
    pdf.hidden = true;
    pdf.style.display = 'none';
    pdf.removeAttribute('src');
  }
  const captionEl = root.querySelector('.chat-image-viewer-caption');
  if (video) {
    if (source) {
      video.hidden = false;
      video.style.display = 'block';
      video.src = source;
      video.play?.().catch(() => {});
    } else {
      video.hidden = true;
      video.style.display = 'none';
      video.removeAttribute('src');
      if (captionEl) captionEl.textContent = `${caption ? caption + ' · ' : ''}Video file not downloaded. View in chat or download from WhatsApp.`;
    }
  }
  if (captionEl && source) captionEl.textContent = caption;
  root.hidden = false;
  root.setAttribute('aria-hidden', 'false');
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const quoteEl = event.target?.closest?.('.msg-quote-inline');
    if (quoteEl) {
      const qMid = quoteEl.dataset.quotedMid;
      if (qMid) {
        event.preventDefault();
        event.stopPropagation();
        const targetBlock = document.querySelector(`.msg-block[data-message-id="${CSS.escape(qMid)}"]`);
        if (targetBlock) {
          targetBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetBlock.classList.add('flash');
          setTimeout(() => targetBlock.classList.remove('flash'), 1200);
        } else if (typeof window !== 'undefined' && typeof window.openChatTab === 'function' && store?.activeChat) {
          window.openChatTab(store.activeChat, '', { focusMessageId: qMid });
        } else if (typeof window !== 'undefined' && typeof window.openChat === 'function' && store?.activeChat) {
          window.openChat(store.activeChat, qMid);
        }
      }
      return;
    }

    const pdfContainer = event.target?.closest?.('.msg-media-pdf-container');
    if (pdfContainer) {
      event.preventDefault();
      const url = pdfContainer.dataset.pdfUrl;
      if (url) {
        openChatPdfViewer(url, pdfContainer.dataset.caption || 'PDF Document');
      }
      return;
    }

    const image = event.target?.closest?.('.msg-media-img');
    if (!image) return;
    event.preventDefault();
    const wrap = image.closest('.media-wrap');
    openChatImageViewer(image.currentSrc || image.src, image.alt, wrap?.querySelector('.media-cap')?.textContent || '');
  });

  /** Expand video into the lightbox (native fullscreen is also enabled via Electron permissions). */
  document.addEventListener('dblclick', (event) => {
    const video = event.target?.closest?.('.msg-media-vid');
    if (!video) return;
    event.preventDefault();
    const wrap = video.closest('.media-wrap');
    openChatVideoViewer(video.currentSrc || video.src, wrap?.querySelector('.media-cap')?.textContent || '');
  });
}

/** Classic chat panel + GPT WhatsApp transcript. */
function msgBlocks(selector = '.msg-block[data-message-id]') {
  return document.querySelectorAll(`#cv-messages ${selector}, #gpt-wa-view ${selector}`);
}

export function applyMessageRevokedToDom(data) {
  const mid = data?.messageId != null ? String(data.messageId) : '';
  if (!mid) return;
  msgBlocks().forEach((block) => {
    if (String(block.dataset.messageId) !== mid) return;
    const bubble = block.querySelector('.bubble');
    if (!bubble) return;
    const time = bubble.querySelector('.time');
    const timeHtml = time ? time.outerHTML : '';
    const sender = bubble.querySelector('.sender');
    const senderHtml = sender ? sender.outerHTML : '';
    bubble.innerHTML = `${senderHtml}<span class="msg-deleted-label">This message was deleted</span>${timeHtml}`;
    block.querySelector('.bubble-toolbar')?.remove();
    block.querySelector('.bubble-reactions')?.remove();
  });
}

export function applyMessageDeletedToDom(data) {
  const mid = data?.messageId != null ? String(data.messageId) : '';
  if (!mid) return;
  msgBlocks().forEach((block) => {
    if (String(block.dataset.messageId) === mid) block.remove();
  });
}

export function applyMessageEditedToDom(data) {
  const mid = data?.messageId != null ? String(data.messageId) : '';
  if (!mid || data?.text == null) return;
  msgBlocks().forEach((block) => {
    if (String(block.dataset.messageId) !== mid) return;
    const textEl = block.querySelector('.bubble .text');
    if (textEl) textEl.innerHTML = formatMessageTextHtml(String(data.text));
  });
}

function telHrefFromPhone(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  return digits ? `tel:${escAttr(digits)}` : '';
}

/** Rich UI for shared contact cards (structured JSON from server). */
function renderContactCardHtml(m) {
  let p = null;
  try {
    const raw = m.contactPayload != null ? String(m.contactPayload) : '';
    if (!raw.trim()) return '';
    p = JSON.parse(raw);
  } catch {
    return '';
  }
  if (!p || !Array.isArray(p.contacts) || !p.contacts.length) return '';
  let blocks = '';
  for (const c of p.contacts) {
    const rows = [];
    const name = (c.displayName != null && String(c.displayName).trim()) || 'Contact';
    rows.push(`<div class="msg-contact-name">${esc(name)}</div>`);
    if (c.organization) rows.push(`<div class="msg-contact-row"><span class="msg-contact-k">Org</span> ${esc(String(c.organization))}</div>`);
    for (const ph of c.phones || []) {
      const t = String(ph).trim();
      if (!t) continue;
      const href = telHrefFromPhone(t);
      rows.push(href
        ? `<div class="msg-contact-row"><span class="msg-contact-k">Phone</span> <a href="${href}">${esc(t)}</a></div>`
        : `<div class="msg-contact-row"><span class="msg-contact-k">Phone</span> ${esc(t)}</div>`);
    }
    for (const em of c.emails || []) {
      const e = String(em).trim();
      if (!e) continue;
      rows.push(`<div class="msg-contact-row"><span class="msg-contact-k">Email</span> <a href="${escAttr(`mailto:${e}`)}">${esc(e)}</a></div>`);
    }
    const rawV = (c.rawVcard != null && String(c.rawVcard).trim()) ? String(c.rawVcard).trim() : '';
    if (rawV) {
      rows.push(`<details class="msg-contact-raw"><summary>Full vCard</summary><pre class="msg-contact-pre">${esc(rawV)}</pre></details>`);
    }
    blocks += `<div class="msg-contact-entry">${rows.join('')}</div>`;
  }
  return `<div class="msg-contact-card" role="region" aria-label="Contact card">${blocks}</div>`;
}

/** WhatsApp-style quoted reply inside a message bubble. */
export function renderQuotedPreviewHtml(quotedPayload) {
  if (!quotedPayload) return '';
  let q = quotedPayload;
  if (typeof q === 'string') {
    try { q = JSON.parse(q); } catch { return ''; }
  }
  if (!q || typeof q !== 'object' || !q.messageId) return '';
  const head = q.sender || 'Reply';
  const isImg = q.mediaType === 'image';
  const isVid = q.mediaType === 'video';
  const isDoc = q.mediaType === 'document';
  const isAudio = q.mediaType === 'audio';
  const isSticker = q.mediaType === 'sticker';
  let mediaLabel = '';
  if (isImg) mediaLabel = 'Photo';
  else if (isVid) mediaLabel = 'Video';
  else if (isDoc) mediaLabel = 'Document';
  else if (isAudio) mediaLabel = 'Voice note';
  else if (isSticker) mediaLabel = 'Sticker';
  else if (q.mediaType) mediaLabel = `[${q.mediaType}]`;

  const text = q.text || mediaLabel || '';
  const thumb = q.thumbData || '';

  return `<div class="wa-quote msg-quote-inline" data-quoted-mid="${escAttr(q.messageId)}" title="Jump to quoted message" role="button" tabindex="0"><span class="wa-quote-bar" aria-hidden="true"></span>${thumb ? `<img class="wa-quote-thumb" src="${escAttr(thumb)}" alt="" />` : (isImg ? `<span class="wa-quote-thumb-placeholder">📷</span>` : '')}<div class="wa-quote-body"><span class="wa-quote-head">${esc(head)}</span><span class="wa-quote-text">${isImg && !q.text ? '📷 ' : ''}${esc(text)}</span></div></div>`;
}

function parseReactionCounts(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return raw;
  try {
    const o = JSON.parse(String(raw));
    return typeof o === 'object' && o !== null && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function reactionCountsHtml(counts) {
  const o = parseReactionCounts(counts);
  const entries = Object.entries(o).filter(([, n]) => Number(n) > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  const inner = entries.map(([e, n]) => {
    const num = Number(n);
    return `<button type="button" class="rx-chip" data-reaction-emoji="${escAttr(e)}" data-reaction-count="${num}" title="View reactions" aria-label="View reactions">${esc(e)}${num > 1 ? `<span class="rx-n">${num}</span>` : ''}</button>`;
  }).join('');
  return `<div class="bubble-reactions" aria-label="Reactions">${inner}</div>`;
}

const ownReactionByMessage = new Map();

function loadOwnReactions() {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const raw = sessionStorage.getItem('wa_own_reactions');
      if (raw) {
        const obj = JSON.parse(raw);
        for (const [k, v] of Object.entries(obj)) {
          if (k && v) ownReactionByMessage.set(k, String(v));
        }
      }
    }
  } catch (_) {}
}
function saveOwnReactions() {
  try {
    if (typeof sessionStorage !== 'undefined') {
      const entries = [...ownReactionByMessage.entries()].slice(-200);
      sessionStorage.setItem('wa_own_reactions', JSON.stringify(Object.fromEntries(entries)));
    }
  } catch (_) {}
}
loadOwnReactions();

/**
 * Synchronize reaction counts & own user reaction across memory caches
 * so chat switching and tab navigation never lose reactions.
 */
export function updateCachedMessageReactions(chatJid, messageId, counts, userReaction = undefined) {
  if (!messageId) return;
  const countsJson = counts ? JSON.stringify(counts) : null;
  const midStr = String(messageId);
  const targetNorm = chatJid ? String(chatJid).replace(/:[^@]+@/, '@') : '';

  // 1. Update store._chatMessageCache (classic UI transcript cache)
  try {
    if (store && store._chatMessageCache) {
      for (const [cj, entry] of store._chatMessageCache.entries()) {
        const cjNorm = String(cj || '').replace(/:[^@]+@/, '@');
        if (!chatJid || cj === chatJid || (targetNorm && cjNorm === targetNorm)) {
          if (Array.isArray(entry?.msgs)) {
            const target = entry.msgs.find((m) => String(m.messageId) === midStr);
            if (target) {
              target.reactionsJson = countsJson;
              if (userReaction !== undefined) target.userReaction = userReaction;
            }
          }
        }
      }
    }
  } catch (_) {}

  // 2. Update window.__gptState.chatMessages (GPT app chat tabs cache)
  try {
    if (typeof window !== 'undefined' && window.__gptState?.chatMessages) {
      for (const [cj, msgs] of window.__gptState.chatMessages.entries()) {
        const cjNorm = String(cj || '').replace(/:[^@]+@/, '@');
        if (!chatJid || cj === chatJid || (targetNorm && cjNorm === targetNorm)) {
          if (Array.isArray(msgs)) {
            const target = msgs.find((m) => String(m.messageId) === midStr);
            if (target) {
              target.reactionsJson = countsJson;
              if (userReaction !== undefined) target.userReaction = userReaction;
            }
          }
        }
      }
    }
  } catch (_) {}

  // 3. Invalidate details modal cache
  try {
    invalidateReactionDetailsCache(chatJid, messageId);
  } catch (_) {}
}

function reactionCountsFromBlock(block) {
  const counts = {};
  block.querySelectorAll('.bubble-reactions .rx-chip').forEach((chip) => {
    const emoji = chip.getAttribute('data-reaction-emoji');
    const count = Number(chip.getAttribute('data-reaction-count')) || 0;
    if (emoji && count > 0) counts[emoji] = count;
  });
  return counts;
}

export function replaceBlockReactionCounts(block, counts) {
  const rxBar = block.querySelector('.bubble-reaction-bar');
  const previous = rxBar ? rxBar.querySelector('.bubble-reactions') : block.querySelector('.bubble-reactions');
  const html = reactionCountsHtml(counts);
  if (!html) {
    previous?.remove();
    rxBar?.classList.remove('has-reactions');
  } else if (previous) {
    previous.outerHTML = html;
    rxBar?.classList.add('has-reactions');
  } else if (rxBar) {
    rxBar.insertAdjacentHTML('afterbegin', html);
    rxBar.classList.add('has-reactions');
  } else {
    block.insertAdjacentHTML('beforeend', html);
  }
}

function findReactionBlock(chatJid, messageId) {
  return [...msgBlocks()].find((block) =>
    block.getAttribute('data-message-id') === String(messageId)
    && (!chatJid || block.getAttribute('data-storage-jid') === String(chatJid)),
  ) || null;
}

export function applyIncomingReactionToDom(data) {
  const { chatJid, messageId, counts } = data || {};
  if (!messageId || !counts || typeof counts !== 'object') return;
  const block = findReactionBlock(chatJid, messageId);
  if (block) replaceBlockReactionCounts(block, counts);
  updateCachedMessageReactions(chatJid, messageId, counts);
}

export async function postWaReaction(chatJid, messageId, emoji) {
  const key = `${chatJid}\u0000${messageId}`;
  const block = findReactionBlock(chatJid, messageId);
  const before = block ? reactionCountsFromBlock(block) : null;
  const priorOwn = ownReactionByMessage.get(key) || '';
  const nextEmoji = String(emoji ?? '');
  const effectiveEmoji = nextEmoji && nextEmoji === priorOwn ? '' : nextEmoji;
  if (block && before) {
    const optimistic = { ...before };
    if (priorOwn && optimistic[priorOwn]) {
      optimistic[priorOwn] -= 1;
      if (optimistic[priorOwn] <= 0) delete optimistic[priorOwn];
    }
    if (effectiveEmoji) optimistic[effectiveEmoji] = (Number(optimistic[effectiveEmoji]) || 0) + 1;
    replaceBlockReactionCounts(block, optimistic);
  }
  if (effectiveEmoji) {
    ownReactionByMessage.set(key, effectiveEmoji);
    recordRecentEmoji(effectiveEmoji);
  } else {
    ownReactionByMessage.delete(key);
  }
  saveOwnReactions();
  updateCachedMessageReactions(chatJid, messageId, before ? { ...before } : null, effectiveEmoji);

  try {
    const r = await fetch('/api/wa/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatJid, messageId, emoji: effectiveEmoji }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || 'Reaction failed');
  } catch (error) {
    if (priorOwn) ownReactionByMessage.set(key, priorOwn);
    else ownReactionByMessage.delete(key);
    saveOwnReactions();
    if (block && before) replaceBlockReactionCounts(block, before);
    updateCachedMessageReactions(chatJid, messageId, before, priorOwn);
    throw error;
  }
}

/** Escape text but turn http(s) URLs into breakable links (long links must not blow layout). */
function formatMessageTextHtml(raw) {
  const t = String(raw || '');
  if (!t) return '';
  const re = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]}'"])/gi;
  let html = '';
  let last = 0;
  let m;
  while ((m = re.exec(t)) !== null) {
    html += esc(t.slice(last, m.index));
    const url = m[1];
    html += `<a class="msg-link" href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`;
    last = m.index + url.length;
  }
  html += esc(t.slice(last));
  return html;
}

export function mediaIndexStateHtml(m) {
  const status = String(m?.mediaIndexStatus || '').toLowerCase();
  if (!status || status === 'indexed') return '';
  const labels = {
    processing: 'Indexing…',
    pending: 'Waiting to be indexed',
    unsupported: 'Metadata only · media search unavailable with current AI provider',
    failed: 'Indexing failed · filename/caption may still be searchable',
  };
  return `<span class="media-index-state ${escAttr(status)}" title="${escAttr(m.mediaIndexError || '')}">${esc(labels[status] || 'Index status unavailable')}</span>`;
}

export function buildChatMessagesHtml(sortedAsc, jid, focusMessageId, anchorBelowTs) {
  const isGroup = jid.includes('@g.us');
  let html = '', lastDate = '';
  if (anchorBelowTs != null && anchorBelowTs !== '') {
    const ad = messageTimestampToDate(anchorBelowTs);
    lastDate = ad ? ad.toDateString() : '';
  }
  const focusStr = focusMessageId != null ? String(focusMessageId) : '';
  for (const m of sortedAsc) {
    const d = messageTimestampToDate(m.timestamp);
    const ds = d ? formatChatDateSeparator(d) : '';
    const dsKey = d ? d.toDateString() : '';
    if (dsKey && dsKey !== lastDate) {
      html += `<div class="date-sep"><span>${esc(ds)}</span></div>`;
      lastDate = dsKey;
    }
    const out = m.sender === 'You';
    const ts = d ? formatChatBubbleDateTime(d) : '';
    const ticks = out ? receiptTicksHtml(m.receiptStatus) : '';
    const isDirectChat = !isGroup && jid !== 'status@broadcast' && !String(jid).endsWith('@imported');
    const effectiveSenderJid = m.senderJid || (isDirectChat ? jid : '');
    let sender = '';
    if (!out && m.sender) {
      const sjidAttr = effectiveSenderJid ? ` data-sender-jid="${escAttr(effectiveSenderJid)}"` : '';
      if (isGroup || jid === 'status@broadcast') {
        const colors = ['#1fa855','#6b46c1','#d93025','#1a73e8','#e8710a','#9334e6','#0d652d'];
        sender = `<div class="sender"${sjidAttr} style="color:${colors[hash(m.sender) % colors.length]}">${esc(m.sender)}</div>`;
      } else {
        sender = `<div class="sender sender-direct"${sjidAttr}>${esc(m.sender)}</div>`;
      }
    }
    const cap = m.mediaCaption ? esc(m.mediaCaption) : '';
    const mid = m.messageId != null ? String(m.messageId) : '';
    const mediaUrl = mid && m.hasMediaFile ? mediaUrlForMessage(mid) : '';
    const mediaDl = mediaUrl ? messageMediaDownloadAnchor(mid) : '';
    let body = '';
    const contactHtml = renderContactCardHtml(m);
    if (contactHtml) {
      body = contactHtml;
    } else if (mediaUrl && (m.mediaType === 'image' || m.mediaType === 'sticker')) {
      body = `<span class="media-wrap"><img class="msg-media-img" src="${escAttr(mediaUrl)}" alt="" loading="lazy" decoding="async">${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}${cap ? `<span class="media-cap">${cap}</span>` : ''}${mediaIndexStateHtml(m)}${mediaDl}</span>`;
    } else if (mediaUrl && m.mediaType === 'video') {
      body = `<span class="media-wrap"><video class="msg-media-vid" src="${escAttr(mediaUrl)}" controls playsinline preload="metadata"></video>${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}${cap ? `<span class="media-cap">${cap}</span>` : ''}${mediaIndexStateHtml(m)}${mediaDl}</span>`;
    } else if (mediaUrl && m.mediaType === 'audio') {
      // WhatsApp-style voice note: compact pill with circular play button,
      // pseudo-waveform bars, and duration — instead of the raw browser
      // <audio controls> bar, which looked like a generic left-aligned control.
      const barCount = 28;
      const bars = Array.from({ length: barCount }, (_, i) => {
        // Deterministic pseudo-waveform derived from the message id so the
        // shape is stable across re-renders.
        const seed = hash(`${mid}:${i}`) || (i * 37 + 7);
        const h = 4 + (seed % 13); // 4..16px
        return `<span class="vn-bar" style="height:${h}px"></span>`;
      }).join('');
      body = `<span class="media-wrap">
        <span class="wa-voice-note" data-mid="${escAttr(mid)}">
          <button type="button" class="vn-play" aria-label="Play voice note" data-state="paused">
            <svg class="vn-icon-play" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
            <svg class="vn-icon-pause" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" style="display:none"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
          </button>
          <span class="vn-track">${bars}</span>
          <span class="vn-time">0:00</span>
          <audio class="vn-audio" src="${escAttr(mediaUrl)}" preload="metadata"></audio>
        </span>
        ${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}
        ${cap ? `<span class="media-cap">${cap}</span>` : ''}
        ${mediaIndexStateHtml(m)}${mediaDl}
      </span>`;
    } else if (mediaUrl && m.mediaType === 'document') {
      const joint = `${m.mediaCaption || ''} ${m.text || ''}`.toLowerCase();
      const isPdf = joint.includes('.pdf');
      const label = esc((m.mediaCaption || m.text || 'Document').trim() || 'Document');
      if (isPdf) {
        const rawCap = (m.mediaCaption || m.text || label || 'PDF Document').trim();
        const pdfCap = cap ? cap : `<span class="media-cap">${label}</span>`;
        body = `<span class="media-wrap"><div class="msg-media-pdf-container" data-pdf-url="${escAttr(mediaUrl)}" data-caption="${escAttr(rawCap)}" role="button" tabindex="0" title="Click to enlarge PDF"><div class="msg-media-pdf msg-media-pdf-card"><span class="msg-media-pdf-icon" aria-hidden="true">PDF</span><span class="msg-media-pdf-info"><span class="msg-media-pdf-name">${esc(rawCap)}</span><span class="msg-media-pdf-hint">Click to preview document</span></span></div><div class="msg-media-pdf-overlay"><span class="msg-media-pdf-badge"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg><span>Click to enlarge</span></span></div></div>${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}${pdfCap}${mediaIndexStateHtml(m)}${mediaDl}</span>`;
      } else {
        // Non-PDF docs (xlsx/csv/docx): force download — inline open often fails or shows garbage.
        const dlHref = mediaDownloadUrl(mid) || mediaUrl;
        body = `<span class="media-wrap"><a class="msg-media-doc" href="${escAttr(dlHref)}" download>${label}</a>${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}${cap ? `<span class="media-cap">${cap}</span>` : ''}${mediaIndexStateHtml(m)}${mediaDl}</span>`;
      }
    } else if ((m.mediaUnavailable || m.mediaTooLarge) && m.mediaType) {
      const isLarge = Boolean(m.mediaTooLarge);
      const why = isLarge ? 'deferred (large video)' : 'no longer available on WhatsApp';
      const actionText = isLarge ? 'Load video' : 'Retry';
      const unavailRetry = mid
        ? ` <button type="button" class="media-retry" data-wa-media-retry data-message-id="${escAttr(mid)}">${actionText}</button>`
        : '';
      body = `<span class="media-wrap">${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}<span class="media-badge media-unavailable">${esc(m.mediaType)} · ${why}${unavailRetry}${cap ? ' · ' + cap : ''}</span></span>`;
    } else if (m.mediaPending && m.mediaType && String(m.chatJid || jid).endsWith('@imported')) {
      body = `<span class="media-wrap">${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}<span class="media-badge media-unavailable">${esc(m.mediaType)} not included in the export${cap ? ' · ' + cap : ''}</span></span>`;
    } else if (m.mediaPending && m.mediaType && m.mediaQueued) {
      body = `<span class="media-wrap">${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}<span class="media-badge media-pending">Loading ${esc(m.mediaType)}…${cap ? ' ' + cap : ''}</span></span>`;
    } else if (m.mediaPending && m.mediaType) {
      body = `<span class="media-wrap">${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}<span class="media-badge media-not-downloaded">${esc(m.mediaType)} not downloaded <button type="button" class="media-retry" data-wa-media-retry${mid ? ` data-message-id="${escAttr(mid)}"` : ''}>Retry</button>${cap ? ' · ' + cap : ''}</span></span>`;
    } else if (m.mediaType && (!m.text || String(m.text).startsWith('['))) {
      body = `<span class="media-wrap">${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}<span class="media-badge">[${esc(m.mediaType)}]${cap ? ' ' + cap : ''}</span></span>`;
    } else {
      body = `<span class="text">${formatMessageTextHtml(m.text || '')}</span>`;
    }
    const numId = m.id != null ? String(m.id) : '';
    const cleanFocus = focusStr ? focusStr.replace(/^m/i, '') : '';
    const isFocus = focusStr && (mid === focusStr || mid === cleanFocus || numId === focusStr || numId === cleanFocus);
    const focusCls = isFocus ? ' msg-focus' : '';
    const dataId = numId ? ` data-id="${escAttr(numId)}"` : '';
    const dataMid = mid ? ` data-message-id="${escAttr(mid)}"` : '';
    const storageJid = m.chatJid || jid;
    const storageAttr = ` data-storage-jid="${escAttr(storageJid)}"`;
    const midAttr = mid ? ` data-message-id="${escAttr(mid)}"` : '';
    const isDeleted = String(m.text || '').trim() === 'This message was deleted' && !m.mediaType;
    if (isDeleted) {
      body = `<span class="msg-deleted-label">This message was deleted</span>`;
    }
    const previewTxt = (m.text || m.mediaCaption || (m.mediaType ? `[${m.mediaType}]` : '')).trim().slice(0, 160);
    const quoteHtml = isDeleted ? '' : renderQuotedPreviewHtml(m.quotedPayload);
    const rxHtml = isDeleted ? '' : reactionCountsHtml(m.reactionsJson);
    const aiSvg = '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2z"/></svg>';
    const liveOk = canSendMessageToJid(jid);
    const canReply = liveOk && !isDeleted;
    const canForward = (store._waState === 'READY' || store._waState === 'SYNCING') && !isDeleted && !jid.endsWith('@imported');
    const canEdit = liveOk && out && !isDeleted && !!(m.text && String(m.text).trim()) && !m.mediaType;
    const canDelete = !!mid && !isDeleted;
    let menu = '';
    // Media context for the WhatsApp-style reply quote (label + thumbnail).
    // Thumb only for renderable media with a local file; sender only for incoming.
    const replyMetaAttrs = (m.mediaType ? ` data-media-type="${escAttr(m.mediaType)}"` : '')
      + (mediaUrl && ['image', 'video', 'sticker'].includes(m.mediaType) ? ` data-media-thumb="${escAttr(mediaUrl)}"` : '')
      + (!out && m.sender ? ` data-sender="${escAttr(m.sender)}"` : '');
    // WhatsApp-style message menu rows (▾ chevron on hover opens this menu).
    const menuRow = (cls, attrs, icon, label) =>
      `<button type="button" class="wa-menu-item ${cls}" role="menuitem" ${attrs}>${icon}<span>${label}</span></button>`;
    if (canReply) {
      menu += menuRow('mi-reply', `data-wa-reply="1" data-reply-preview="${escAttr(previewTxt)}"${replyMetaAttrs}`, WA_ICONS.reply, 'Reply');
    }
    const copyText = extractMessageCopyText(m);
    menu += menuRow('mi-copy', `data-wa-copy="1" data-copy-text="${escAttr(copyText)}"`, WA_ICONS.copy, 'Copy message');
    menu += menuRow('mi-ai', `data-wa-ai-search="1" data-ai-preview="${escAttr(previewTxt)}"`, aiSvg, 'AI search');
    if (canForward) {
      menu += menuRow('mi-forward', `data-wa-forward="1" data-forward-preview="${escAttr(previewTxt)}"${replyMetaAttrs}`, WA_ICONS.forward, 'Forward');
    }
    if (canEdit) {
      menu += menuRow('mi-edit', `data-wa-edit="1" data-edit-preview="${escAttr(String(m.text || '').slice(0, 2000))}"`, WA_ICONS.edit, 'Edit');
    }
    if (canDelete) {
      menu += menuRow('mi-delete', `data-wa-delete="1" data-from-me="${out ? '1' : '0'}"`, WA_ICONS.delete, 'Delete');
    }
    const toolbar = mid && !isDeleted ? `<div class="bubble-toolbar">
          <div class="bubble-toolbar-reacts">
          <button type="button" class="wa-tb wa-msg-menu-toggle" data-wa-menu-toggle="1" title="Message options" aria-label="Message options" aria-haspopup="menu">${WA_ICONS.chevron}</button>
          </div>
          <div class="wa-msg-menu" hidden role="menu" aria-label="Message options">${menu}</div>
        </div>` : '';
    const hasRx = Boolean(rxHtml && rxHtml.trim());
    const rxBarCls = `bubble-reaction-bar${hasRx ? ' has-reactions' : ''}`;
    const rxBar = mid && !isDeleted ? `<div class="${rxBarCls}">
          ${rxHtml}
          ${liveOk ? `<button type="button" class="bubble-react-trigger" data-wa-emoji-picker-toggle="1" title="React" aria-label="React"><svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-3.5-9c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm7 0c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg></button><div class="wa-reaction-picker" hidden aria-label="Choose a reaction"></div>` : ''}
        </div>` : '';
    html += `<div class="msg-block ${out ? 'out' : 'in'}"${storageAttr}${midAttr}${dataId} data-from-me="${out ? '1' : '0'}">${toolbar}<div class="bubble ${out ? 'out' : 'in'}${focusCls}"${dataMid}${dataId}>${sender}${quoteHtml}${body}<span class="time" title="${d ? escAttr(dateFmt('full').format(d)) : ''}">${ts ? esc(ts) : '—'}${ticks}</span></div>${rxBar}</div>`;
  }
  return html;
}

/** Threshold (px) for "still following the live edge" — same idea as GPT nearBottom. */
const CHAT_NEAR_BOTTOM_PX = 120;

/** Last successful paint fingerprint per transcript container (avoids flicker on no-op reloads). */
const _paintFpByEl = new WeakMap();

/** Stable digest of fields that change bubble HTML / toolbar affordances. */
export function messagesPaintFingerprint(msgs, jid = '', focusMessageId = null) {
  // WA link state gates reply/react/edit menu rows — include so connect/disconnect still re-paints.
  const parts = [
    `j:${jid || ''}`,
    `f:${focusMessageId != null ? String(focusMessageId) : ''}`,
    `wa:${store._waState || ''}`,
  ];
  for (const m of msgs || []) {
    parts.push([
      m.messageId || '',
      m.text || '',
      m.sender || '',
      m.senderJid || '',
      m.timestamp || '',
      m.mediaType || '',
      m.mediaPath || '',
      m.hasMediaFile ? 1 : 0,
      m.mediaCaption || '',
      m.mediaPending ? 1 : 0,
      m.mediaUnavailable ? 1 : 0,
      m.mediaTooLarge ? 1 : 0,
      m.mediaQueued ? 1 : 0,
      m.receiptStatus || '',
      m.reactionsJson || '',
      m.quotedPayload || '',
      m.chatJid || '',
    ].join('\x1f'));
  }
  return parts.join('\x1e');
}

function shouldSkipPaint(container, fp) {
  if (!container || !fp) return false;
  return _paintFpByEl.get(container) === fp;
}

function rememberPaint(container, fp) {
  if (container && fp) _paintFpByEl.set(container, fp);
}

/**
 * Snapshot scroll intent before a full transcript re-paint.
 * Live refreshes must not yank readers who scrolled up to read history.
 */
export function captureChatScrollAnchor(container) {
  if (!container) return { mode: 'bottom' };
  const gap = container.scrollHeight - container.scrollTop - container.clientHeight;
  if (gap < CHAT_NEAR_BOTTOM_PX) return { mode: 'bottom' };
  const top = container.scrollTop;
  const blocks = container.querySelectorAll('.msg-block[data-message-id]');
  for (const block of blocks) {
    if (block.offsetTop + block.offsetHeight > top + 8) {
      return {
        mode: 'anchor',
        id: block.getAttribute('data-message-id'),
        offset: block.offsetTop - top,
      };
    }
  }
  return { mode: 'top', scrollTop: top };
}

/** Restore sticky-bottom or a pre-paint message anchor after innerHTML replace. */
export function restoreChatScroll(container, anchor, { force = false } = {}) {
  if (!container) return;
  if (force || !anchor || anchor.mode === 'bottom') {
    container.scrollTop = container.scrollHeight;
    return;
  }
  if (anchor.mode === 'anchor' && anchor.id) {
    const want = String(anchor.id);
    const target = [...container.querySelectorAll('.msg-block[data-message-id]')].find(
      (el) => el.getAttribute('data-message-id') === want,
    );
    if (target) {
      container.scrollTop = Math.max(0, target.offsetTop - (anchor.offset || 0));
      return;
    }
  }
  if (anchor.mode === 'top' && typeof anchor.scrollTop === 'number') {
    container.scrollTop = anchor.scrollTop;
    return;
  }
  container.scrollTop = container.scrollHeight;
}

/**
 * @param {object[]} msgs
 * @param {string} jid
 * @param {string|null} [focusMessageId]
 * @param {{ forceScroll?: boolean }} [opts] forceScroll=true on initial open / own send;
 *   live refreshes omit it so scrolled-up readers keep their place.
 */
export function renderMessages(msgs, jid, focusMessageId = null, { forceScroll = false } = {}) {
  const c = $('#cv-messages');
  if (!msgs.length) {
    const ch = store.chatData.find((row) => row.chatJid === jid);
    const claimed = Number(ch?.messageCount) || 0;
    const hint = claimed > 0
      ? `This chat reports ${claimed.toLocaleString()} messages, but none loaded. Try refreshing, or re-import the chat export.`
      : 'No messages in this chat yet.';
    c.innerHTML = `<div class="empty-messages-state"><div class="empty-messages-title">No messages to show</div><div class="empty-messages-hint">${esc(hint)}</div></div>`;
    rememberPaint(c, messagesPaintFingerprint([], jid, focusMessageId));
    return;
  }
  const focusStr = focusMessageId != null ? String(focusMessageId) : '';
  const sorted = [...msgs].sort((a, b) => {
    const ta = messageTimestampToDate(a.timestamp)?.getTime() ?? 0;
    const tb = messageTimestampToDate(b.timestamp)?.getTime() ?? 0;
    return ta - tb;
  });
  const fp = messagesPaintFingerprint(sorted, jid, focusMessageId);
  // Live Baileys re-deliveries often re-fetch identical rows; replacing DOM kills hover menus.
  if (!forceScroll && !focusStr && shouldSkipPaint(c, fp)) return;
  const anchor = focusStr || forceScroll ? null : captureChatScrollAnchor(c);
  const html = buildChatMessagesHtml(sorted, jid, focusMessageId, null);
  c.innerHTML = html;
  rememberPaint(c, fp);
  if (focusStr) {
    const target = [...c.querySelectorAll('.bubble[data-message-id]')].find(
      el => el.getAttribute('data-message-id') === focusStr
    );
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => { target.classList.remove('msg-focus'); }, 2800);
    } else {
      c.scrollTop = c.scrollHeight;
    }
  } else {
    restoreChatScroll(c, anchor, { force: forceScroll });
  }
}
// --- WhatsApp-style voice note playback (delegated) ---
export function _vnFmt(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}
export function _vnNote(audio) {
  if (!audio) return null;
  return audio.closest?.('.wa-voice-note')
    || (audio.parentElement ? audio.parentElement.querySelector('.wa-voice-note') : null)
    || (audio.closest?.('.media-wrap') ? audio.closest('.media-wrap').querySelector('.wa-voice-note') : null);
}
export function _vnAudio(target) {
  if (!target) return null;
  const note = target.closest?.('.wa-voice-note') || target.closest?.('.media-wrap');
  if (!note) return null;
  return note.querySelector('.vn-audio')
    || (note.parentElement ? note.parentElement.querySelector('.vn-audio') : null);
}
export function _vnUpdate(note, audio) {
  if (!note || !audio) return;
  const bars = note.querySelectorAll('.vn-bar');
  const dur = isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
  const pct = dur > 0 ? (audio.currentTime / dur) : 0;
  const filled = Math.round(pct * bars.length);
  bars.forEach((b, i) => b.classList.toggle('vn-bar--filled', i < filled));
  const t = note.querySelector('.vn-time');
  if (t) t.textContent = audio.paused ? (dur > 0 ? _vnFmt(dur) : '0:00') : _vnFmt(audio.currentTime);
  const btn = note.querySelector('.vn-play');
  if (btn) {
    btn.dataset.state = audio.paused ? 'paused' : 'playing';
    btn.setAttribute('aria-label', audio.paused ? 'Play voice note' : 'Pause voice note');
    const play = btn.querySelector('.vn-icon-play');
    const pause = btn.querySelector('.vn-icon-pause');
    if (play) play.style.display = audio.paused ? '' : 'none';
    if (pause) pause.style.display = audio.paused ? 'none' : '';
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('click', (ev) => {
    const track = ev.target && ev.target.closest ? ev.target.closest('.vn-track') : null;
    if (track) {
      const note = track.closest('.wa-voice-note');
      const audio = _vnAudio(note);
      if (audio && isFinite(audio.duration) && audio.duration > 0) {
        ev.preventDefault();
        const rect = track.getBoundingClientRect();
        const clickX = ev.clientX - rect.left;
        const ratio = Math.max(0, Math.min(1, clickX / rect.width));
        audio.currentTime = ratio * audio.duration;
        _vnUpdate(note, audio);
        return;
      }
    }

    const btn = ev.target && ev.target.closest ? ev.target.closest('.vn-play') : null;
    if (!btn) return;
    const note = btn.closest('.wa-voice-note');
    const audio = _vnAudio(note);
    if (!audio) return;
    ev.preventDefault();
    if (audio.paused) {
      document.querySelectorAll('.vn-audio').forEach((a) => {
        if (a !== audio && !a.paused) {
          a.pause();
        }
      });
      audio.play().catch((err) => {
        console.warn('Voice note playback failed:', err);
      });
    } else {
      audio.pause();
    }
  }, true);
  ['timeupdate', 'loadedmetadata', 'durationchange', 'play', 'pause', 'ended', 'error'].forEach((evt) => {
    document.addEventListener(evt, (ev) => {
      const audio = ev.target;
      if (!audio || !audio.classList || !audio.classList.contains('vn-audio')) return;
      const note = _vnNote(audio);
      if (evt === 'ended') {
        audio.currentTime = 0;
        audio.pause();
      } else if (evt === 'error') {
        console.warn('[Audio] playback error on voice note:', audio.error, audio.src);
      }
      _vnUpdate(note, audio);
    }, true);
  });

  // Replace broken inline images/videos (e.g. missing/corrupt local file) with a clean
  // "image unavailable" / "video unavailable" badge + Retry button rather than a broken icon.
  document.addEventListener('error', (ev) => {
    const media = ev.target;
    if (!media || !media.classList) return;
    const isImg = media.classList.contains('msg-media-img');
    const isVid = media.classList.contains('msg-media-vid');
    if (!isImg && !isVid) return;
    if (media.closest?.('.chat-image-viewer')) return;
    if (media.dataset.mediaErrorHandled === '1') return;
    media.dataset.mediaErrorHandled = '1';

    const wrap = media.closest?.('.media-wrap');
    if (!wrap) return;
    const block = media.closest?.('.msg-block[data-message-id]');
    const mid = block?.getAttribute('data-message-id') || '';
    const kindLabel = isVid ? 'video' : 'image';

    const badge = document.createElement('span');
    badge.className = 'media-badge media-unavailable';
    badge.textContent = `${kindLabel} unavailable`;
    if (mid) {
      badge.appendChild(document.createTextNode(' '));
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'media-retry';
      retryBtn.setAttribute('data-wa-media-retry', '');
      retryBtn.setAttribute('data-message-id', mid);
      retryBtn.textContent = 'Retry';
      badge.appendChild(retryBtn);
    }

    wrap.querySelectorAll('.msg-media-actions').forEach((el) => el.remove());
    media.replaceWith(badge);
  }, true);
}

/**
 * Update sender names in-place across rendered message bubbles without repainting the transcript.
 * @param {string} chatJid
 * @param {Array<{ senderJid: string, sender: string }>} updates
 */
export function applyResolvedSenderNamesToDom(chatJid, updates) {
  if (typeof document === 'undefined' || !Array.isArray(updates) || !updates.length) return;
  const colors = ['#1fa855','#6b46c1','#d93025','#1a73e8','#e8710a','#9334e6','#0d652d'];
  const updateSenderEl = (el, name) => {
    if (el.textContent === name) return;
    el.textContent = name;
    if (!el.classList.contains('sender-direct') && el.closest('.msg-block')?.classList.contains('in')) {
      el.style.color = colors[hash(name) % colors.length];
    }
  };

  for (const u of updates) {
    const sjid = u?.senderJid;
    const name = u?.sender;
    if (!sjid || !name) continue;
    try {
      const selector = `.sender[data-sender-jid="${CSS.escape(sjid)}"]`;
      const els = document.querySelectorAll(`#cv-messages ${selector}, #gpt-wa-view ${selector}`);
      for (const el of els) {
        updateSenderEl(el, name);
      }
    } catch (_) {}
  }

  // Merged 1:1 chats can carry incoming rows with either the LID or PN sender_jid.
  const isDirectChat = Boolean(
    chatJid
    && !String(chatJid).endsWith('@g.us')
    && chatJid !== 'status@broadcast'
    && !String(chatJid).endsWith('@broadcast')
    && !String(chatJid).endsWith('@imported'),
  );
  if (isDirectChat && updates.length) {
    const activeJid = store.activeChat || '';
    const activeAliases = new Set(
      [activeJid, ...(Array.isArray(store.activeChatLinkedJids) ? store.activeChatLinkedJids : [])]
        .filter(Boolean)
        .map(String),
    );
    if (activeAliases.has(String(chatJid))) {
      const directUpdate = updates.find(
        (u) => u?.sender && (!u.senderJid || activeAliases.has(String(u.senderJid))),
      );
      const directName = directUpdate?.sender;
      if (directName) {
        const directEls = document.querySelectorAll(
          '#cv-messages .msg-block.in .sender.sender-direct, #gpt-wa-view .msg-block.in .sender.sender-direct',
        );
        for (const el of directEls) {
          const elSjid = el.getAttribute('data-sender-jid') || '';
          if (!elSjid || activeAliases.has(elSjid)) {
            updateSenderEl(el, directName);
          }
        }
      }
    }
  }
}

export function senderNeedsResolution(sender) {
  const s = typeof sender === 'string' ? sender.trim() : '';
  if (!s || s === 'You') return false;
  if (s.startsWith('Contact (') || s === 'Unknown' || s === '~') return true;
  if (/^\d{7,20}$/.test(s)) return true;
  if (/^\+?[\d\s().-]{7,}$/.test(s) && !/\p{L}/u.test(s)) return true;
  return false;
}

export function formatMediaRetryNote(result) {
  if (!result) return '';
  if (result.imported) return 'Imported chat — media is not included in the export.';
  if (result.history?.requested) {
    return result.history.purpose === 'media_rehydrate'
      ? 'Requested from phone — keep WhatsApp online; media will appear automatically.'
      : 'Asked phone for older history — keep WhatsApp online.';
  }
  if (result.history?.error) return result.history.error;
  if (!result.waConnected) return 'Connect WhatsApp in Settings → Linked Devices to download media.';
  if ((result.mediaQueued || 0) > 0 || result.mediaInFlight) return 'Downloading media in background…';
  if (!result.hasStub) return 'Older message has no newer anchor — try “Load older messages from phone” in chat menu.';
  return 'Retry queued — media may take a moment or have expired on WhatsApp.';
}

export function showMediaRetryNote(container, messageId, result) {
  if (!container || !messageId || !result) return;
  const noteText = formatMediaRetryNote(result);
  if (!noteText) return;
  try {
    const block = container.querySelector(`.msg-block[data-message-id="${CSS.escape(String(messageId))}"]`);
    if (!block) return;
    const wrap = block.querySelector('.media-wrap');
    if (!wrap) return;
    // Only attach a retry status note if media did not already finish rendering inline.
    if (!wrap.querySelector('.media-badge')) return;
    wrap.querySelectorAll('.media-retry-note').forEach((n) => n.remove());
    const note = document.createElement('span');
    note.className = 'media-retry-note';
    note.textContent = noteText;
    wrap.appendChild(note);
  } catch (_) {}
}

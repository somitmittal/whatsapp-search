import { store } from './store.js';
import { canSendMessageToJid } from './composer.js';
import { dateFmt, formatChatBubbleDateTime, formatChatDateSeparator, messageTimestampToDate, receiptTicksHtml } from './format.js';
import { mediaDownloadUrl, mediaUrlForMessage, messageMediaDownloadAnchor } from './media.js';
import { $, esc, escAttr, hash } from './util.js';

let imageViewerEl = null;
/** WhatsApp Web icon paths for the message menu (mirror of WA's own icons). */
const WA_ICONS = {
  chevron: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M12 15.5 6.6 10.1 8 8.7l4 4 4-4 1.4 1.4z"/></svg>',
  reply: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M10 8.5V13a1 1 0 0 1-1.7.71l-4.6-4.6a1 1 0 0 1 0-1.41l4.6-4.6A1 1 0 0 1 10 3.8V5.5c5.6.3 9.7 3.7 10.9 9.1.4 1.7.2 3-.2 4.3-.2.6-1 .7-1.4.2-2.4-3.4-5.4-5.6-9.3-6.3z"/></svg>',
  forward: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M14 8.5V13a1 1 0 0 0 1.7.71l4.6-4.6a1 1 0 0 0 0-1.41l-4.6-4.6A1 1 0 0 0 14 3.8V5.5C8.4 5.8 4.3 9.2 3.1 14.6c-.4 1.7-.2 3 .2 4.3.2.6 1 .7 1.4.2 2.4-3.4 5.4-5.6 9.3-6.3z"/></svg>',
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
  const picker = button?.closest('.bubble-toolbar')?.querySelector('.wa-reaction-picker');
  if (!picker) return;
  const shouldOpen = picker.hidden;
  closeReactionEmojiPickers();
  closeMessageMenus();
  if (shouldOpen && !picker.dataset.ready) {
    // WhatsApp's react sheet: six quick reactions first, then the full grid.
    picker.innerHTML = `<div class="wa-picker-quick">`
      + WA_REACTION_QUICK.map((emoji) =>
        `<button type="button" class="wa-tb" data-wa-react="${escAttr(emoji)}" title="React ${escAttr(emoji)}" aria-label="React ${escAttr(emoji)}">${esc(emoji)}</button>`).join('')
      + `<button type="button" class="wa-tb wa-tb-remove-reaction" data-wa-react="" title="Remove your reaction" aria-label="Remove your reaction">-</button>`
      + `</div>`
      + `<div class="wa-picker-grid">`
      + MORE_REACTION_EMOJIS.map((emoji) =>
        `<button type="button" class="wa-tb" data-wa-react="${escAttr(emoji)}" title="React ${escAttr(emoji)}" aria-label="React ${escAttr(emoji)}">${esc(emoji)}</button>`).join('')
      + `</div>`;
    picker.dataset.ready = '1';
  }
  picker.hidden = !shouldOpen;
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

document.addEventListener('click', (event) => {
  if (event.target?.closest?.('.wa-msg-menu')) closeMessageMenus();
  if (!event.target?.closest?.('.bubble-toolbar')) {
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

function closeChatImageViewer() {
  if (!imageViewerEl) return;
  imageViewerEl.hidden = true;
  imageViewerEl.setAttribute('aria-hidden', 'true');
  const image = imageViewerEl.querySelector('img');
  if (image) image.removeAttribute('src');
}

function openChatImageViewer(source, alt = '', caption = '') {
  if (!imageViewerEl) {
    imageViewerEl = document.createElement('div');
    imageViewerEl.className = 'chat-image-viewer';
    imageViewerEl.hidden = true;
    imageViewerEl.setAttribute('role', 'dialog');
    imageViewerEl.setAttribute('aria-modal', 'true');
    imageViewerEl.setAttribute('aria-label', 'Image preview');
    imageViewerEl.innerHTML = '<button class="chat-image-viewer-close" type="button" aria-label="Close image">×</button><div class="chat-image-viewer-stage"><img alt=""></div><div class="chat-image-viewer-caption"></div>';
    document.body.appendChild(imageViewerEl);
    imageViewerEl.addEventListener('click', (event) => {
      if (event.target === imageViewerEl || event.target.closest('.chat-image-viewer-close')) closeChatImageViewer();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && imageViewerEl && !imageViewerEl.hidden) closeChatImageViewer();
    });
  }
  const image = imageViewerEl.querySelector('img');
  if (image) { image.src = source; image.alt = alt || 'Chat image'; }
  const captionEl = imageViewerEl.querySelector('.chat-image-viewer-caption');
  if (captionEl) captionEl.textContent = caption;
  imageViewerEl.hidden = false;
  imageViewerEl.setAttribute('aria-hidden', 'false');
}

document.addEventListener('click', (event) => {
  const image = event.target?.closest?.('.msg-media-img');
  if (!image) return;
  event.preventDefault();
  const wrap = image.closest('.media-wrap');
  openChatImageViewer(image.currentSrc || image.src, image.alt, wrap?.querySelector('.media-cap')?.textContent || '');
});

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
    return `<span class="rx-chip" data-reaction-emoji="${escAttr(e)}" data-reaction-count="${num}">${esc(e)}${num > 1 ? `<span class="rx-n">${num}</span>` : ''}</span>`;
  }).join('');
  return `<div class="bubble-reactions" aria-label="Reactions">${inner}</div>`;
}

const ownReactionByMessage = new Map();

function reactionCountsFromBlock(block) {
  const counts = {};
  block.querySelectorAll('.bubble-reactions .rx-chip').forEach((chip) => {
    const emoji = chip.getAttribute('data-reaction-emoji');
    const count = Number(chip.getAttribute('data-reaction-count')) || 0;
    if (emoji && count > 0) counts[emoji] = count;
  });
  return counts;
}

function replaceBlockReactionCounts(block, counts) {
  const previous = block.querySelector('.bubble-reactions');
  const html = reactionCountsHtml(counts);
  if (!html) previous?.remove();
  else if (previous) previous.outerHTML = html;
  else block.insertAdjacentHTML('beforeend', html);
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
  if (effectiveEmoji) ownReactionByMessage.set(key, effectiveEmoji);
  else ownReactionByMessage.delete(key);
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
    if (block && before) replaceBlockReactionCounts(block, before);
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
    let sender = '';
    if (!out && m.sender) {
      if (isGroup || jid === 'status@broadcast') {
        const colors = ['#1fa855','#6b46c1','#d93025','#1a73e8','#e8710a','#9334e6','#0d652d'];
        sender = `<div class="sender" style="color:${colors[hash(m.sender) % colors.length]}">${esc(m.sender)}</div>`;
      } else {
        sender = `<div class="sender" style="color:#54656f">${esc(m.sender)}</div>`;
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
      body = `<span class="media-wrap"><img class="msg-media-img" src="${escAttr(mediaUrl)}" alt="" loading="lazy">${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}${cap ? `<span class="media-cap">${cap}</span>` : ''}${mediaIndexStateHtml(m)}${mediaDl}</span>`;
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
        </span>
        <audio class="vn-audio" src="${escAttr(mediaUrl)}" preload="metadata"></audio>
        ${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}
        ${cap ? `<span class="media-cap">${cap}</span>` : ''}
        ${mediaIndexStateHtml(m)}${mediaDl}
      </span>`;
    } else if (mediaUrl && m.mediaType === 'document') {
      const joint = `${m.mediaCaption || ''} ${m.text || ''}`.toLowerCase();
      const isPdf = joint.includes('.pdf');
      const label = esc((m.mediaCaption || m.text || 'Document').trim() || 'Document');
      if (isPdf) {
        body = `<span class="media-wrap"><iframe class="msg-media-pdf" src="${escAttr(mediaUrl)}" title="PDF"></iframe>${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}${cap ? `<span class="media-cap">${cap}</span>` : `<span class="media-cap">${label}</span>`}${mediaIndexStateHtml(m)}${mediaDl}</span>`;
      } else {
        // Non-PDF docs (xlsx/csv/docx): force download — inline open often fails or shows garbage.
        const dlHref = mediaDownloadUrl(mid) || mediaUrl;
        body = `<span class="media-wrap"><a class="msg-media-doc" href="${escAttr(dlHref)}" download>${label}</a>${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}${cap ? `<span class="media-cap">${cap}</span>` : ''}${mediaIndexStateHtml(m)}${mediaDl}</span>`;
      }
    } else if ((m.mediaUnavailable || m.mediaTooLarge) && m.mediaType) {
      const why = m.mediaTooLarge ? 'too large to download — open on your phone' : 'no longer available on WhatsApp';
      body = `<span class="media-wrap">${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}<span class="media-badge media-unavailable">${esc(m.mediaType)} ${why}${cap ? ' · ' + cap : ''}</span></span>`;
    } else if (m.mediaPending && m.mediaType && String(m.chatJid || jid).endsWith('@imported')) {
      body = `<span class="media-wrap">${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}<span class="media-badge media-unavailable">${esc(m.mediaType)} not included in the export${cap ? ' · ' + cap : ''}</span></span>`;
    } else if (m.mediaPending && m.mediaType && m.mediaQueued) {
      body = `<span class="media-wrap">${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}<span class="media-badge media-pending">Loading ${esc(m.mediaType)}…${cap ? ' ' + cap : ''}</span></span>`;
    } else if (m.mediaPending && m.mediaType) {
      body = `<span class="media-wrap">${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}<span class="media-badge media-not-downloaded">${esc(m.mediaType)} not downloaded <button type="button" class="media-retry" data-wa-media-retry>Retry</button>${cap ? ' · ' + cap : ''}</span></span>`;
    } else if (m.mediaType && (!m.text || String(m.text).startsWith('['))) {
      body = `<span class="media-wrap">${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}<span class="media-badge">[${esc(m.mediaType)}]${cap ? ' ' + cap : ''}</span></span>`;
    } else {
      body = `<span class="text">${formatMessageTextHtml(m.text || '')}</span>`;
    }
    const isFocus = focusStr && mid === focusStr;
    const focusCls = isFocus ? ' msg-focus' : '';
    const dataMid = mid ? ` data-message-id="${escAttr(mid)}"` : '';
    const storageJid = m.chatJid || jid;
    const storageAttr = ` data-storage-jid="${escAttr(storageJid)}"`;
    const midAttr = mid ? ` data-message-id="${escAttr(mid)}"` : '';
    const isDeleted = String(m.text || '').trim() === 'This message was deleted' && !m.mediaType;
    if (isDeleted) {
      body = `<span class="msg-deleted-label">This message was deleted</span>`;
    }
    const previewTxt = (m.text || m.mediaCaption || (m.mediaType ? `[${m.mediaType}]` : '')).trim().slice(0, 160);
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
    if (liveOk) {
      menu += menuRow('mi-react', 'data-wa-emoji-picker-toggle="1"', WA_ICONS.react, 'React');
    }
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
          ${liveOk ? '<div class="wa-reaction-picker" hidden aria-label="Choose a reaction"></div>' : ''}
        </div>` : '';
    html += `<div class="msg-block ${out ? 'out' : 'in'}"${storageAttr}${midAttr} data-from-me="${out ? '1' : '0'}">${toolbar}<div class="bubble ${out ? 'out' : 'in'}${focusCls}"${dataMid}>${sender}${body}<span class="time" title="${d ? escAttr(dateFmt('full').format(d)) : ''}">${ts ? esc(ts) : '—'}${ticks}</span></div>${rxHtml}</div>`;
  }
  return html;
}

/** Threshold (px) for "still following the live edge" — same idea as GPT nearBottom. */
const CHAT_NEAR_BOTTOM_PX = 120;

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
    return;
  }
  const focusStr = focusMessageId != null ? String(focusMessageId) : '';
  const anchor = focusStr || forceScroll ? null : captureChatScrollAnchor(c);
  const sorted = [...msgs].sort((a, b) => {
    const ta = messageTimestampToDate(a.timestamp)?.getTime() ?? 0;
    const tb = messageTimestampToDate(b.timestamp)?.getTime() ?? 0;
    return ta - tb;
  });
  const html = buildChatMessagesHtml(sorted, jid, focusMessageId, null);
  c.innerHTML = html;
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
function _vnFmt(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}
function _vnNote(audio) { return audio ? audio.closest('.wa-voice-note') : null; }
function _vnUpdate(note, audio) {
  if (!note || !audio) return;
  const bars = note.querySelectorAll('.vn-bar');
  const dur = isFinite(audio.duration) ? audio.duration : 0;
  const pct = dur > 0 ? (audio.currentTime / dur) : 0;
  const filled = Math.round(pct * bars.length);
  bars.forEach((b, i) => b.classList.toggle('vn-bar--filled', i < filled));
  const t = note.querySelector('.vn-time');
  if (t) t.textContent = audio.paused ? _vnFmt(dur) : _vnFmt(audio.currentTime);
  const btn = note.querySelector('.vn-play');
  if (btn) {
    const play = btn.querySelector('.vn-icon-play');
    const pause = btn.querySelector('.vn-icon-pause');
    if (play) play.style.display = audio.paused ? '' : 'none';
    if (pause) pause.style.display = audio.paused ? 'none' : '';
  }
}
document.addEventListener('click', (ev) => {
  const btn = ev.target && ev.target.closest ? ev.target.closest('.vn-play') : null;
  if (!btn) return;
  const note = btn.closest('.wa-voice-note');
  const audio = note ? note.querySelector('.vn-audio') : null;
  if (!audio) return;
  ev.preventDefault();
  if (audio.paused) { audio.play().catch(() => {}); } else { audio.pause(); }
}, true);
['timeupdate', 'loadedmetadata', 'durationchange', 'play', 'pause', 'ended'].forEach((evt) => {
  document.addEventListener(evt, (ev) => {
    const audio = ev.target;
    if (!audio || !audio.classList || !audio.classList.contains('vn-audio')) return;
    const note = _vnNote(audio);
    if (evt === 'ended') {
      audio.currentTime = 0;
      audio.pause();
    }
    _vnUpdate(note, audio);
  }, true);
});
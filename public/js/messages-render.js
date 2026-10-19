import { store } from './store.js';
import { canSendMessageToJid } from './composer.js';
import { dateFmt, formatChatBubbleDateTime, formatChatDateSeparator, messageTimestampToDate, receiptTicksHtml } from './format.js';
import { mediaDownloadUrl, mediaUrlForMessage, messageMediaDownloadAnchor } from './media.js';
import { $, esc, escAttr, hash } from './util.js';

let imageViewerEl = null;
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
  if (shouldOpen && !picker.dataset.ready) {
    picker.innerHTML = MORE_REACTION_EMOJIS.map((emoji) =>
      `<button type="button" class="wa-tb" data-wa-react="${escAttr(emoji)}" title="React ${escAttr(emoji)}" aria-label="React ${escAttr(emoji)}">${esc(emoji)}</button>`,
    ).join('');
    picker.dataset.ready = '1';
  }
  picker.hidden = !shouldOpen;
}

export function closeReactionEmojiPickers() {
  document.querySelectorAll('.wa-reaction-picker:not([hidden])').forEach((picker) => { picker.hidden = true; });
}

document.addEventListener('click', (event) => {
  if (!event.target?.closest?.('.bubble-toolbar')) closeReactionEmojiPickers();
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
      body = `<span class="media-wrap"><audio class="msg-media-audio" src="${escAttr(mediaUrl)}" controls preload="metadata"></audio>${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}${cap ? `<span class="media-cap">${cap}</span>` : ''}${mediaIndexStateHtml(m)}${mediaDl}</span>`;
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
    } else if (m.mediaPending && m.mediaType) {
      body = `<span class="media-wrap">${ts ? `<span class="msg-media-datetime">${esc(ts)}</span>` : ''}<span class="media-badge media-pending">Loading ${esc(m.mediaType)}…${cap ? ' ' + cap : ''}</span></span>`;
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
    let actionBtns = '';
    if (canReply) {
      actionBtns += `<button type="button" class="wa-tb wa-tb-reply" data-wa-reply="1" data-reply-preview="${escAttr(previewTxt)}" title="Reply">↩︎</button>`;
    }
    if (canForward) {
      actionBtns += `<button type="button" class="wa-tb wa-tb-forward" data-wa-forward="1" data-forward-preview="${escAttr(previewTxt)}" title="Forward">↪</button>`;
    }
    if (canEdit) {
      actionBtns += `<button type="button" class="wa-tb wa-tb-edit" data-wa-edit="1" data-edit-preview="${escAttr(String(m.text || '').slice(0, 2000))}" title="Edit">✎</button>`;
    }
    if (canDelete) {
      actionBtns += `<button type="button" class="wa-tb wa-tb-delete" data-wa-delete="1" data-from-me="${out ? '1' : '0'}" title="Delete">🗑</button>`;
    }
    const toolbar = mid && !isDeleted ? `<div class="bubble-toolbar">
          <div class="bubble-toolbar-reacts">
          <button type="button" class="wa-tb wa-tb-ai" data-wa-ai-search="1" data-ai-preview="${escAttr(previewTxt)}" title="AI Search using this message as context" aria-label="AI Search using this message">${aiSvg}</button>
          ${liveOk ? `
          <button type="button" class="wa-tb" data-wa-react="👍" title="React 👍">👍</button>
          <button type="button" class="wa-tb" data-wa-react="❤️" title="React ❤️">❤️</button>
          <button type="button" class="wa-tb" data-wa-react="😂" title="React 😂">😂</button>
          <button type="button" class="wa-tb" data-wa-react="😮" title="React 😮">😮</button>
          <button type="button" class="wa-tb" data-wa-react="😢" title="React 😢">😢</button>
          <button type="button" class="wa-tb wa-tb-emoji-picker" data-wa-emoji-picker-toggle="1" title="More emojis" aria-label="More emojis">☻</button>
          <button type="button" class="wa-tb wa-tb-remove-reaction" data-wa-react="" title="Remove your reaction" aria-label="Remove your reaction">×</button>` : ''}
          ${actionBtns}
          </div>
          ${liveOk ? '<div class="wa-reaction-picker" hidden aria-label="Choose a reaction"></div>' : ''}
        </div>` : '';
    html += `<div class="msg-block ${out ? 'out' : 'in'}"${storageAttr}${midAttr} data-from-me="${out ? '1' : '0'}">${toolbar}<div class="bubble ${out ? 'out' : 'in'}${focusCls}"${dataMid}>${sender}${body}<span class="time" title="${d ? escAttr(dateFmt('full').format(d)) : ''}">${ts ? esc(ts) : '—'}${ticks}</span></div>${rxHtml}</div>`;
  }
  return html;
}

export function renderMessages(msgs, jid, focusMessageId = null) {
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
  const sorted = [...msgs].sort((a, b) => {
    const ta = messageTimestampToDate(a.timestamp)?.getTime() ?? 0;
    const tb = messageTimestampToDate(b.timestamp)?.getTime() ?? 0;
    return ta - tb;
  });
  const html = buildChatMessagesHtml(sorted, jid, focusMessageId, null);
  c.innerHTML = html;
  const focusStr = focusMessageId != null ? String(focusMessageId) : '';
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
    c.scrollTop = c.scrollHeight;
  }
}

/**
 * Shared WhatsApp-style chat row markup (sidebar + GPT left pane).
 */
import { avatarLetterFor, chatAvatarHtml } from './avatars.js';
import { displayChatTitle, formatCount, formatDate, receiptTicksHtml } from './format.js';
import { esc, escAttr } from './util.js';

export function chatRowHtml(ch) {
  const n = displayChatTitle(ch.chatJid, ch.chatName || ch.chatJid);
  const avatarHtml = chatAvatarHtml(
    ch.chatJid,
    avatarLetterFor(ch.chatJid, n, ch.participantCount),
    ch.hasAvatar,
    ch.avatarRev,
  );
  const unread = Math.max(0, Number(ch.unreadCount) || 0);
  const unreadBadge = unread > 0
    ? `<span class="chat-count-badge" title="${unread} unread">${esc(formatCount(unread))}</span>`
    : '';
  const previewTicks = ch.lastMessageFromMe
    ? `<span class="chat-preview-ticks">${receiptTicksHtml(ch.lastMessageReceipt)}</span>`
    : '';
  const preview = ch.lastMessagePreview
    ? `<span class="chat-preview-text">${esc(ch.lastMessagePreview)}</span>`
    : '';
  return `<div class="chat-item${unread ? ' unread' : ''}" data-jid="${esc(ch.chatJid)}" data-name="${escAttr(n)}">
      <div class="chat-avatar${ch.hasAvatar ? ' has-photo' : ''}" data-avatar-jid="${escAttr(ch.chatJid)}" data-avatar-title="${escAttr(n)}" data-avatar-rev="${escAttr(String(ch.avatarRev || 0))}"${ch.hasAvatar ? ' role="button" tabindex="0" title="View photo"' : ''}>${avatarHtml}</div>
      <div class="chat-meta">
        <div class="chat-meta-top">
          <span class="chat-name">${esc(n)}</span>
          <span class="chat-date">${esc(formatDate(ch.lastMessageTs))}</span>
        </div>
        <div class="chat-meta-bottom">
          <span class="chat-preview">${previewTicks}${preview}</span>
          <span class="chat-meta-badges">
            ${unreadBadge}
          </span>
        </div>
      </div>
      <div class="chat-index-track" data-jid="${esc(ch.chatJid)}" style="display:none"><div class="chat-index-bar"></div></div>
    </div>`;
}

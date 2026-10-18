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
  const pct = ch.searchIndexPct ?? 0;
  const sumT = ch.summarizedThreads ?? 0;
  const totT = ch.totalThreads ?? 0;
  const aiDone = !!ch.aiSearchComplete;
  const aiReady = !!ch.aiSearchReady;
  let badgeClass = '';
  let badgeText = 'AI —';
  if (aiDone) { badgeClass = 'complete'; badgeText = 'AI ✓'; }
  else if (aiReady) { badgeClass = 'partial'; badgeText = pct + '%'; }
  const optedIn = !!ch.indexOptedIn;
  const aiToggle = `<button class="chat-ai-toggle${optedIn ? ' on' : ''}" type="button"
      aria-pressed="${optedIn}" title="${optedIn ? 'Disable AI indexing for this chat' : 'Enable AI indexing for this chat'}">AI</button>`;
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
            ${aiToggle}
            <span class="search-badge ${badgeClass}" title="Thread summaries for AI search">${esc(badgeText)}</span>
            ${unreadBadge}
          </span>
        </div>
      </div>
      <div class="search-index-track${aiDone ? ' done' : ''}" data-jid="${esc(ch.chatJid)}"
        data-search-pct="${pct}" data-search-complete="${aiDone ? '1' : '0'}"
        data-summarized="${sumT}" data-total-threads="${totT}"
        style="${optedIn && ch.messageCount > 0 ? '' : 'display:none'}"><div class="search-index-bar"></div></div>
      <div class="chat-index-track" data-jid="${esc(ch.chatJid)}" style="display:none"><div class="chat-index-bar"></div></div>
    </div>`;
}

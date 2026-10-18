import { dayBoundsFromTimestamp } from '../expenses/chat-expense-extractor.js';

function localDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Calendar day named in the command, if any. `now` is injectable so tests do not depend on the clock. */
export function dateHintFromRest(rest, now = new Date()) {
  const iso = String(rest || '').match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  if (/\btoday\b/i.test(rest)) return localDate(now);
  if (/\byesterday\b/i.test(rest)) {
    return localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  }
  return null;
}

export function fileHintFromRest(rest) {
  const match = String(rest || '').match(/\S+\.(?:xlsx|csv)\b/i);
  return match ? match[0] : null;
}

export function chatQueryFromRest(rest) {
  return String(rest || '')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\b(?:today|yesterday)\b/gi, ' ')
    .replace(/\S+\.(?:xlsx|csv)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function groupMentions(mentions) {
  return (mentions || []).filter((pin) => String(pin?.chatJid || '').endsWith('@g.us'));
}

function ask(answer, choices = []) {
  return { status: 'needs_input', answer, choices };
}

function mentionsChat(chat, query) {
  const name = String(chat?.chatName || '').trim().toLowerCase();
  const q = String(query || '').trim().toLowerCase();
  if (!q || !chat?.chatJid) return false;
  if (q === String(chat.chatJid).toLowerCase()) return true;
  if (!name || name === String(chat.chatJid).toLowerCase()) return false;
  return name === q || name.includes(q) || q.includes(name);
}

/** A pin, or the open group tab. Extra sentence text does not count as a missing name. */
function attachedGroup({ mentions = [], scopeChatJid = null, scopeChatName = null, command }) {
  const groups = groupMentions(mentions);
  if (groups.length === 1) return { status: 'ready', chat: groups[0] };
  if (groups.length > 1) {
    return ask(
      'Which site should I reconcile? Send one of these:',
      groups.map((pin) => ({
        label: pin.chatName || pin.chatJid,
        message: `${command} ${pin.chatName || pin.chatJid}`,
      })),
    );
  }
  if (String(scopeChatJid || '').endsWith('@g.us')) {
    return { status: 'ready', chat: { chatJid: scopeChatJid, chatName: scopeChatName || scopeChatJid } };
  }
  return null;
}

/**
 * Which site group the command refers to.
 * An explicit chat name in the command wins. Other words ("please do it for this chat")
 * are instructions: the @mention or the open chat is already the site.
 */
export function resolveExpenseChat({
  rest = '',
  mentions = [],
  scopeChatJid = null,
  scopeChatName = null,
  resolveChat = () => null,
  command = '/accountant/expense-reconciliation',
} = {}) {
  const attached = attachedGroup({ mentions, scopeChatJid, scopeChatName, command });
  const chatQuery = chatQueryFromRest(rest);
  if (chatQuery) {
    const named = resolveChat(chatQuery);
    if (named?.chatJid && mentionsChat(named, chatQuery)) {
      if (!String(named.chatJid).endsWith('@g.us')) {
        return ask(`${named.chatName || chatQuery} is not a group. Expense reconciliation runs on a site group.`);
      }
      return { status: 'ready', chat: named };
    }
    if (attached) return attached;
    return ask(`No chat matches "${chatQuery}". Name the site group, or @mention it, then run \`${command}\` again.`);
  }
  if (attached) return attached;
  return ask(`Which site chat? @mention the group or send \`${command}\` with its name.`);
}

/**
 * Which sheet in an already-chosen chat. One match is used. Several matches are listed
 * and not guessed, including when the user did not name a file or a day.
 * `sheets` must already be newest-first.
 */
export function resolveExpenseSheet({
  rest = '',
  chat,
  sheets = [],
  now = new Date(),
  command = '/accountant/expense-reconciliation',
} = {}) {
  const dateHint = dateHintFromRest(rest, now);
  const fileHint = fileHintFromRest(rest);
  let candidates = sheets.filter((sheet) => !sheet.chatJid || sheet.chatJid === chat.chatJid);
  if (dateHint) {
    candidates = candidates.filter((sheet) => dayBoundsFromTimestamp(sheet.timestamp).date === dateHint);
  }
  if (fileHint) {
    const needle = fileHint.toLowerCase();
    candidates = candidates.filter((sheet) => String(sheet.fileName || '').toLowerCase().includes(needle));
  }
  if (candidates.length === 1) {
    const sheet = candidates[0];
    return { status: 'ready', chat, messageId: sheet.messageId, fileName: sheet.fileName, dateHint };
  }
  if (candidates.length > 1) {
    return ask(
      `More than one sheet in ${chat.chatName || 'that chat'} matches. Send one of these:`,
      candidates.slice(0, 8).map((sheet) => {
        const day = dayBoundsFromTimestamp(sheet.timestamp).date;
        return {
          label: `${sheet.fileName} (${day})`,
          message: `${command} ${chat.chatName || ''} ${sheet.fileName}`.replace(/\s+/g, ' ').trim(),
        };
      }),
    );
  }
  const when = dateHint ? ` on ${dateHint}` : '';
  const named = fileHint ? ` named ${fileHint}` : '';
  return ask(`No expense sheet${named} in ${chat.chatName || 'that chat'}${when}. Post the Excel or CSV in the group, then run \`${command}\` again.`);
}

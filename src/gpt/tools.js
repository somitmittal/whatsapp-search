import { GPT_LIMITS } from './limits.js';
import {
  formatSummaryLine,
  hybridSearch,
  packMessages,
  parseDay,
} from './retrieval.js';
import { resolveSiteChat, summarizeExpenseRun } from '../search/search-conversation-service.js';

export const TOOL_SPECS = [
  {
    name: 'search',
    args: '{"query": str, "chat"?: name, "from"?: "YYYY-MM-DD", "to"?: "YYYY-MM-DD"}',
    about: 'keyword + semantic search over messages (returns hits with surrounding messages)',
  },
  {
    name: 'read',
    args: '{"chat": name, "date"?: "YYYY-MM-DD", "from"?: date, "to"?: date, "around"?: "m123", "last"?: int}',
    about: 'read a chat in order — a day, a date range, around a message, or the last N messages',
  },
  {
    name: 'chats',
    args: '{"query"?: str}',
    about: 'find chats/groups by name, with message counts and last activity',
  },
  {
    name: 'summaries',
    args: '{"query"?: str, "chat"?: name}',
    about: 'indexed thread/day summaries — best for broad "what happened" questions',
  },
  {
    name: 'reconcile',
    args: '{"chat": name}',
    about: "compare a site's chat expenses with that day's Excel sheet (colored sheet in the UI)",
  },
];

function dayRange(args) {
  if (args.date) {
    const s = parseDay(args.date);
    if (s != null) return { startTs: s, endTs: parseDay(args.date, { end: true }) };
  }
  const startTs = args.from ? parseDay(args.from) : null;
  const endTs = args.to ? parseDay(args.to, { end: true }) : null;
  return { startTs, endTs };
}

/**
 * Tool implementations. Each returns `{ text, messages?, payload? }`; `messages` are
 * registered as citable sources for this turn.
 */
export function createToolbox({ db, embeddings, directory, expenseService }) {
  const chatOrNull = (ref) => (ref ? directory.resolve(ref) : null);
  const label = (chat, ref) => (chat ? chat.chatName : ref);

  return {
    async search(args, budget) {
      const query = String(args.query || '').trim();
      if (!query) return { text: 'search needs a "query".' };
      const chat = chatOrNull(args.chat);
      if (args.chat && !chat) return { text: `No chat matches "${args.chat}". Try the chats tool.` };
      const { startTs, endTs } = dayRange(args);
      const { messages } = await hybridSearch({
        db, embeddings, query, chatJid: chat?.chatJid || null, startTs, endTs,
      });
      if (!messages.length) return { text: `No messages found for "${query}"${chat ? ` in ${chat.chatName}` : ''}.` };
      const packed = packMessages(messages, budget, new Set());
      return { text: packed.text, messages };
    },

    async read(args, budget) {
      const chat = chatOrNull(args.chat);
      if (!chat) return { text: `No chat matches "${args.chat || ''}". Try the chats tool.` };
      let rows = [];
      const around = String(args.around || '').match(/^m?(\d+)$/);
      if (around) {
        const [anchor] = db.getMessagesByRowIds([Number(around[1])]);
        if (anchor) {
          const radius = Math.floor(GPT_LIMITS.maxMessagesInContext / 2);
          rows = [anchor, ...db.getChatNeighbors(anchor.chatJid, anchor.timestamp, anchor.id, radius)];
        }
      } else {
        const { startTs, endTs } = dayRange(args);
        if (startTs != null || endTs != null) {
          rows = db.getMessagesInRange({
            chatJid: chat.chatJid, startTs: startTs ?? 0, endTs: endTs ?? undefined,
            limit: GPT_LIMITS.maxMessagesInContext, newestFirst: true,
          });
        } else {
          const n = Math.min(Number(args.last) || GPT_LIMITS.maxMessagesInContext, GPT_LIMITS.maxMessagesInContext);
          rows = db.getMessagesPaginated(chat.chatJid, n, 0);
        }
      }
      if (!rows.length) return { text: `No messages in ${label(chat)} for that range.` };
      const withChat = rows.map((m) => ({ ...m, chatName: m.chatName || chat.chatName }));
      const packed = packMessages(withChat, budget, new Set());
      return { text: packed.text, messages: withChat };
    },

    async chats(args) {
      const rows = directory.search(args.query, 15);
      if (!rows.length) return { text: `No chats match "${args.query || ''}".` };
      return {
        text: rows.map((c) => {
          const last = c.lastMessageTs ? new Date(c.lastMessageTs * 1000).toISOString().slice(0, 10) : '—';
          return `- ${c.chatName} (${c.messageCount} msgs, last ${last})`;
        }).join('\n'),
      };
    },

    async summaries(args) {
      const chat = chatOrNull(args.chat);
      const jid = chat?.chatJid || null;
      const query = String(args.query || '').trim();
      const limit = GPT_LIMITS.maxSummaries;
      const rows = query
        ? [...db.searchThreadSummaries(query, jid, limit), ...db.searchSummaries(query, jid, limit)]
        : [...db.getRecentThreadSummaries(jid, limit)];
      if (!rows.length) {
        return { text: 'No summaries indexed for that yet — use search or read instead.' };
      }
      return { text: rows.slice(0, limit).map(formatSummaryLine).join('\n') };
    },

    async reconcile(args, _budget, ctx) {
      if (!expenseService) return { text: 'Expense reconciliation is not enabled on this install.' };
      const chat = chatOrNull(args.chat);
      const siteJid = resolveSiteChat(db, args.chat || '', chat?.chatJid || ctx.scopeChatJid || null);
      if (!siteJid) {
        const sites = typeof db.listExpenseSiteChats === 'function' ? db.listExpenseSiteChats() : [];
        return { text: `Which site? Known sites: ${sites.map((s) => s.chatName || s.chatJid).join(', ') || 'none configured'}.` };
      }
      ctx.status('Comparing chat expenses with the sheet…');
      const run = await expenseService.runForChat({ chatJid: siteJid, notifyWhatsApp: false, forceRerun: true });
      if (!run || run.status === 'failed') {
        return { text: `Reconciliation failed: ${run?.error || 'unknown error'}` };
      }
      const { answer, expenseDiff } = summarizeExpenseRun(run);
      return { text: answer, payload: { expenseDiff } };
    },
  };
}

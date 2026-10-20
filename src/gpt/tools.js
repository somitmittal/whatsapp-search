import { GPT_LIMITS } from './limits.js';
import {
  formatSummaryLine,
  hybridSearch,
  packMessages,
  parseDay,
} from './retrieval.js';
import { skillCommand } from '../skills/parse-invocation.js';
import { SYSTEM_SKILLS } from '../skills/system-skills.js';

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
    args: '{"chat"?: name}',
    about: "dry-run expense reconciliation for a site group (Excel/CSV in that chat). Pass chat for one site; omit chat when several chats are @mentioned this turn to reconcile each of them.",
  },
];

const EXPENSE_SKILL = SYSTEM_SKILLS.find((s) => s.slug === 'expense-reconciliation');
const EXPENSE_COMMAND = EXPENSE_SKILL ? skillCommand(EXPENSE_SKILL) : '/accountant/expense-reconciliation';

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
export function createToolbox({ db, embeddings, directory, runSkill = null }) {
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
      if (typeof runSkill !== 'function') {
        return { text: 'Expense reconciliation is not enabled on this install.' };
      }
      const named = String(args.chat || '').trim();
      const mentionTargets = (ctx.turnMentions || [])
        .map((m) => String(m.chatName || m.chatJid || '').trim())
        .filter(Boolean);
      // One named chat → that site. Else every @mention this turn. Else thread home.
      const targets = named
        ? [named]
        : (mentionTargets.length ? mentionTargets : (ctx.scopeChatName ? [ctx.scopeChatName] : ['']));

      const runOne = async (siteLabel) => {
        const rest = String(siteLabel || '').trim();
        const resolved = rest ? chatOrNull(rest) : null;
        const text = rest ? `${EXPENSE_COMMAND} ${rest}` : EXPENSE_COMMAND;
        ctx.status?.(`Reconciling${rest ? ` ${rest}` : ''}…`);
        const outcome = await runSkill({
          text,
          // Pin exactly this site so multi-@mention turns do not ask "which site?".
          mentions: resolved
            ? [{ type: 'chat', chatJid: resolved.chatJid, chatName: resolved.chatName }]
            : (rest ? [] : (ctx.turnMentions || [])),
          scopeChatJid: resolved?.chatJid || ctx.scopeChatJid || null,
          scopeChatName: resolved?.chatName || rest || ctx.scopeChatName || null,
          conversationId: ctx.conversationId || null,
          status: ctx.status || null,
          resolveProvider: ctx.resolveProvider || null,
        });
        const site = outcome.expenseDiff?.chatName || rest || 'site';
        const labelled = outcome.expenseDiff
          ? `${outcome.answer}\n\n(Site: ${outcome.expenseDiff.chatName || site})`
          : outcome.answer;
        return { labelled, outcome };
      };

      const parts = [];
      const expenseDiffs = [];
      const skillSteps = [];
      let lastSkillRun = null;
      let lastChoices = [];
      let lastExpenseDiff = null;
      for (const target of targets) {
        const { labelled, outcome } = await runOne(target);
        parts.push(labelled);
        if (outcome.expenseDiff) {
          expenseDiffs.push(outcome.expenseDiff);
          lastExpenseDiff = outcome.expenseDiff;
        }
        if (outcome.skillRun) lastSkillRun = outcome.skillRun;
        if (outcome.choices?.length) lastChoices = outcome.choices;
        if (outcome.steps?.length) skillSteps.push(...outcome.steps);
      }
      return {
        text: parts.join('\n\n---\n\n'),
        payload: {
          ...(lastExpenseDiff ? { expenseDiff: lastExpenseDiff } : {}),
          ...(expenseDiffs.length > 1 ? { expenseDiffs } : {}),
          ...(lastSkillRun ? { skillRun: lastSkillRun } : {}),
          ...(lastChoices.length ? { choices: lastChoices } : {}),
          ...(skillSteps.length ? { skillSteps } : {}),
        },
      };
    },
  };
}

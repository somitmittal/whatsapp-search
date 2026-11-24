import { createRequire } from 'module';
import { existsSync, readFileSync } from 'fs';
import { basename, extname } from 'path';
import { defaultPaddleOcr } from '../ocr/paddle-ocr.js';
import { GPT_LIMITS } from './limits.js';
import {
  formatSummaryLine,
  hybridSearch,
  packMessages,
  parseDay,
} from './retrieval.js';
import { decomposeQuery } from './query-decomposer.js';
import { skillCommand } from '../skills/parse-invocation.js';
import { SYSTEM_SKILLS } from '../skills/system-skills.js';
import { validateWebSearchQuery } from './web-search-guard.js';
import { searchWeb } from './web-search.js';

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
    args: '{"chat"?: name, "date"?: "YYYY-MM-DD or 10 Oct", "file"?: name}',
    about: "dry-run expense reconciliation for a site group (Excel/CSV/Phone-pay PDF in that chat). Pass date when the user named a day (e.g. 10th Oct). Pass chat for one site; omit chat when several chats are @mentioned this turn to reconcile each of them.",
  },
  {
    name: 'web_search',
    args: '{"query": str}',
    about: 'search the public internet for world facts, public news, documentation, or general information outside WhatsApp. PRIVACY GUARD: never pass private chat messages, contact names, or phone numbers.',
  },
  {
    name: 'inspect_document',
    args: '{"message"?: "m123", "chat"?: name, "file"?: name}',
    about: 'inspect and read the complete extracted text, pricing tables, or menu from an attached PDF, document, menu, or receipt from a message handle (e.g. m123) or filename',
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
export function createToolbox({ db, embeddings, directory, runSkill = null, mediaIndexService = null, getProvider = null, webSearchService = null }) {
  const chatOrNull = (ref) => (ref ? directory.resolve(ref) : null);
  const label = (chat, ref) => (chat ? chat.chatName : ref);

  return {
    async search(args, budget) {
      const query = String(args.query || '').trim();
      if (!query) return { text: 'search needs a "query".' };
      const chat = chatOrNull(args.chat);
      if (args.chat && !chat) return { text: `No chat matches "${args.chat}". Try the chats tool.` };
      const { startTs, endTs } = dayRange(args);

      const provider = typeof getProvider === 'function' ? getProvider() : null;
      const intent = await decomposeQuery(query, {
        provider,
        currentChatName: chat?.chatName || null,
      }).catch(() => null);

      let searchRes = await hybridSearch({
        db,
        embeddings,
        query,
        chatJid: chat?.chatJid || null,
        startTs,
        endTs,
        mediaIndexService,
        intent,
      });

      let messages = searchRes.messages;
      let note = '';

      // Intelligent scope fallback: if scoped search yields 0 hits, try entity chats then global
      if (!messages.length && chat) {
        let fallbackChat = null;
        if (Array.isArray(intent?.candidateEntities) && intent.candidateEntities.length) {
          for (const ent of intent.candidateEntities) {
            const found = directory.resolve(ent);
            if (found && found.chatJid !== chat.chatJid) {
              fallbackChat = found;
              break;
            }
          }
        }

        if (fallbackChat) {
          const fbRes = await hybridSearch({
            db,
            embeddings,
            query,
            chatJid: fallbackChat.chatJid,
            startTs,
            endTs,
            mediaIndexService,
            intent,
          });
          if (fbRes.messages.length) {
            messages = fbRes.messages;
            note = `\n(Note: No matches in "${chat.chatName}", but found ${messages.length} relevant message(s) in "${fallbackChat.chatName}")`;
          }
        }

        if (!messages.length && (intent?.isCrossChat === true || args.allChats === true)) {
          const globalRes = await hybridSearch({
            db,
            embeddings,
            query,
            chatJid: null,
            startTs,
            endTs,
            mediaIndexService,
            intent,
          });
          if (globalRes.messages.length) {
            messages = globalRes.messages;
            note = `\n(Note: No matches in "${chat.chatName}", but found ${messages.length} relevant message(s) across other chats)`;
          }
        }
      }

      if (!messages.length) {
        return { text: `No messages found for "${query}"${chat ? ` in ${chat.chatName}` : ''}.` };
      }
      const packed = packMessages(messages, budget, new Set());
      return { text: `${packed.text}${note}`, messages };
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
        const date = String(args.date || '').trim();
        const file = String(args.file || '').trim();
        const resolved = rest ? chatOrNull(rest) : null;
        const text = [EXPENSE_COMMAND, rest, date, file].filter(Boolean).join(' ');
        ctx.status?.(`Reconciling${rest ? ` ${rest}` : ''}${date ? ` (${date})` : ''}…`);
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
      let lastFollowUpPrompt = null;
      for (const target of targets) {
        const { labelled, outcome } = await runOne(target);
        parts.push(labelled);
        if (outcome.expenseDiff) {
          expenseDiffs.push(outcome.expenseDiff);
          lastExpenseDiff = outcome.expenseDiff;
        }
        if (outcome.skillRun) lastSkillRun = outcome.skillRun;
        if (outcome.choices?.length) lastChoices = outcome.choices;
        if (outcome.followUpPrompt) lastFollowUpPrompt = outcome.followUpPrompt;
        if (outcome.steps?.length) skillSteps.push(...outcome.steps);
      }
      return {
        text: parts.join('\n\n---\n\n'),
        payload: {
          ...(lastExpenseDiff ? { expenseDiff: lastExpenseDiff } : {}),
          ...(expenseDiffs.length > 1 ? { expenseDiffs } : {}),
          ...(lastSkillRun ? { skillRun: lastSkillRun } : {}),
          ...(lastChoices.length ? { choices: lastChoices } : {}),
          ...(lastFollowUpPrompt ? { followUpPrompt: lastFollowUpPrompt } : {}),
          ...(skillSteps.length ? { skillSteps } : {}),
        },
      };
    },

    async web_search(args, budget, ctx) {
      const query = String(args?.query || '').trim();
      if (!query) return { text: 'web_search needs a "query".' };

      // Multi-layer privacy guardrail validation
      const guardResult = validateWebSearchQuery(query, {
        directory,
        contextMessages: ctx?.prefetched || [],
      });

      if (!guardResult.allowed) {
        return {
          text: `Blocked by privacy guardrail: ${guardResult.reason}`,
          payload: { privacyBlocked: true, reason: guardResult.reason },
        };
      }

      ctx?.status?.(`Searching the web for “${guardResult.cleanQuery}”…`);

      try {
        const searchFn = webSearchService?.search || searchWeb;
        return await searchFn(guardResult.cleanQuery, { budget });
      } catch (err) {
        return {
          text: `Web search was unable to reach external sources: ${err.message}`,
        };
      }
    },

    async inspect_document(args, budget, ctx) {
      const msgRef = String(args?.message || args?.m || '').trim();
      const fileRef = String(args?.file || args?.fileName || args?.query || '').trim();
      const chat = chatOrNull(args?.chat || ctx?.scopeChatName);

      let targetMsg = null;
      if (msgRef) {
        const m = msgRef.match(/(\d+)/);
        if (m) {
          const id = Number(m[1]);
          targetMsg = (ctx?.prefetched || []).find((row) => row.id === id)
            || db.getMessagesByRowIds([id])?.[0]
            || null;
        }
      }

      if (!targetMsg && (fileRef || chat)) {
        if (fileRef) {
          const candidates = db.searchMessages(fileRef, chat?.chatJid || null, 5);
          targetMsg = candidates.find((c) => (c.mediaPath || c.media_path) || c.mediaType === 'document' || c.media_type === 'document') || candidates[0];
        }
        if (!targetMsg && chat?.chatJid && typeof db.getRecentMediaMessages === 'function') {
          const recentDocs = db.getRecentMediaMessages({ chatJid: chat.chatJid, mediaType: 'document', limit: 3 });
          targetMsg = recentDocs[0];
        }
      }

      if (!targetMsg) {
        return { text: `No matching document message found${msgRef ? ` for ${msgRef}` : ''}. Try the search tool to find the message first.` };
      }

      const filePath = targetMsg.mediaPath || targetMsg.media_path;
      const mediaCap = targetMsg.mediaCaption || targetMsg.media_caption;
      const fn = basename(filePath || mediaCap || 'document');
      let content = targetMsg.mediaAiIndex || targetMsg.media_ai_index || '';

      if (!filePath || !existsSync(filePath)) {
        if (content && content.length > 30) {
          return {
            text: `## Document Content: ${fn} ([m${targetMsg.id}])\n\n${content}`,
            messages: [targetMsg],
          };
        }
        return { text: `Document file for [m${targetMsg.id}] (${fn}) is not available on disk to inspect.` };
      }

      const isJustFilename = !content || content.trim() === fn || !/[a-zA-Z]{3,}.*[a-zA-Z]{3,}/.test(content);
      if (isJustFilename) {
        ctx?.status?.(`Extracting text and tables from ${fn}…`);
        try {
          const buffer = readFileSync(filePath);
          const ext = extname(filePath).toLowerCase();
          let extracted = '';
          if (ext === '.pdf') {
            try {
              const require = createRequire(import.meta.url);
              const parsePdf = require('pdf-parse');
              const data = await parsePdf(buffer, { max: 20 });
              extracted = String(data?.text || '').trim();
            } catch (_) {}
          } else if (['.txt', '.csv', '.json', '.md'].includes(ext)) {
            extracted = buffer.toString('utf8').trim();
          }

          if (!extracted || extracted.length < 50) {
            extracted = await defaultPaddleOcr.extractText(filePath, buffer);
          }
          if (extracted && extracted.length > 20) {
            content = extracted;
            const messageId = targetMsg.messageId || targetMsg.message_id;
            if (messageId && typeof db.updateMediaIndexResult === 'function') {
              db.updateMediaIndexResult(messageId, { text: extracted, status: 'indexed' });
            }
            targetMsg.mediaAiIndex = extracted;
            targetMsg.media_ai_index = extracted;
          }
        } catch (err) {
          console.warn('[inspect_document] Extraction failed:', err.message);
        }
      }

      if (!content || content.trim() === fn) {
        return {
          text: `## Document: ${fn} ([m${targetMsg.id}])\n\nNo readable text or pricing could be extracted from this document.`,
          messages: [targetMsg],
        };
      }

      return {
        text: `## Document Content: ${fn} ([m${targetMsg.id}])\n\n${content}`,
        messages: [targetMsg],
      };
    },
  };
}

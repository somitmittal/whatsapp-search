import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { isExpenseSheetMessage } from '../expenses/expense-reconciliation-service.js';
import { dayBoundsFromDate } from '../expenses/chat-expense-extractor.js';
import { summarizeExpenseRun } from '../search/search-conversation-service.js';
import {
  ambiguousSlug,
  listVisibleSkills,
  matchSkills,
  resolveSkill,
  skillKey,
  skillsInNamespace,
} from './catalog.js';
import { resolveExpenseChat, resolveExpenseSheet } from './expense-inputs.js';
import { parseSkillInvocation, skillCommand } from './parse-invocation.js';

/** Real document name for picker labels — not a hardcoded expenses.xlsx fallback. */
export function sheetFileName(row) {
  const sources = [row?.mediaCaption, row?.text, row?.mediaPath]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  for (const src of sources) {
    const attached = src.match(/<attached:\s*([^>]+)>/i);
    if (attached) {
      const name = basename(attached[1].trim());
      if (/\.(xlsx|xlsm|csv|tsv|txt|pdf|docx)$/i.test(name)) return name;
    }
    const named = src.match(/([^/\\]+?\.(?:xlsx|xlsm|csv|tsv|txt|pdf|docx))\b/i);
    if (named) return basename(named[1].trim());
  }
  const fromPath = basename(String(row?.mediaPath || ''));
  if (/\.(xlsx|xlsm|csv|tsv|txt|pdf|docx)$/i.test(fromPath)) return fromPath;
  return 'expenses.xlsx';
}

function sheetsForChat(db, chatJid) {
  const rows = typeof db.listExpenseSheetMessages === 'function' ? db.listExpenseSheetMessages(chatJid) : [];
  return (rows || [])
    .filter((row) => isExpenseSheetMessage(row, row.mediaPath, { strict: false }))
    .map((row) => ({
      chatJid: row.chatJid,
      messageId: row.messageId,
      fileName: sheetFileName(row),
      timestamp: row.timestamp,
    }));
}

export function coverageForRun(db, run) {
  if (!run?.businessDate || !run?.chatJid) return null;
  let startBounds;
  let endBounds;
  let startDate = run.businessDate;
  let endDate = run.businessDate;
  const range = String(run.businessDate).match(/^(\d{4}-\d{2}-\d{2})\s+[–—-]\s+(\d{4}-\d{2}-\d{2})$/);
  if (range) [, startDate, endDate] = range;
  try {
    startBounds = dayBoundsFromDate(startDate);
    endBounds = dayBoundsFromDate(endDate);
  } catch { return null; }
  if (startDate > endDate) return null;
  const messages = typeof db.getMessagesByTimeRange === 'function'
    ? db.getMessagesByTimeRange(run.chatJid, startBounds.startTs, endBounds.endTs)
    : [];
  return {
    messageCount: Array.isArray(messages) ? messages.length : 0,
    startTs: startBounds.startTs,
    endTs: endBounds.endTs,
    businessDate: run.businessDate,
    startDate,
    endDate,
    chatJid: run.chatJid,
  };
}

export function coverageLine(coverage, chatName) {
  if (!coverage) return '';
  const n = coverage.messageCount;
  const span = coverage.startDate && coverage.endDate && coverage.startDate !== coverage.endDate
    ? `from ${coverage.startDate} to ${coverage.endDate}`
    : `on ${coverage.businessDate}`;
  return `Read ${n} message${n === 1 ? '' : 's'} in ${chatName || 'the chat'} ${span} (that calendar span).`;
}

function isImportedChatJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@imported');
}

function skillRunView(row, { canSend = false } = {}) {
  if (!row) return null;
  const chatJid = row.inputs?.chatJid || null;
  // Imported archives have no live WhatsApp thread — never offer "Send report to the chat".
  const allowSend = canSend && row.status === 'dry_run' && !isImportedChatJid(chatJid);
  return {
    id: row.id,
    namespace: row.namespace,
    slug: row.slug,
    kind: row.kind,
    version: row.version,
    status: row.status,
    coverage: row.coverage || null,
    chatJid,
    canSend: allowSend,
  };
}

export function createSkillRunner({ db, directory, expenseService }) {
  const skills = () => listVisibleSkills(db);

  function record(skill, fields) {
    return db.createSkillRun({
      id: randomUUID(),
      namespace: skill?.namespace || fields.namespace || '',
      slug: skill?.slug || fields.slug || '',
      kind: skill?.kind || 'system',
      version: skill?.version || 1,
      ...fields,
    });
  }

  return {
    list(query, limit = 12) {
      return matchSkills(query, skills(), limit).map((skill) => ({
        namespace: skill.namespace,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        kind: skill.kind,
        path: skillKey(skill),
      }));
    },

    /**
     * Run a slash command. Never calls the chat model.
     * @returns {Promise<{ answer: string, steps: string[], choices: object[], skillRun: object|null, expenseDiff: object|null }>}
     */
    async run({ text, mentions = [], scopeChatJid = null, scopeChatName = null, conversationId = null, status = null, resolveProvider = null }) {
      const invocation = parseSkillInvocation(text);
      if (!invocation) throw new Error('Not a skill command');
      const visible = skills();
      const commandLabel = invocation.namespace
        ? `/${invocation.namespace}/${invocation.slug}`
        : `/${invocation.slug}`;

      if (!invocation.namespace) {
        const sameSlug = ambiguousSlug(invocation, visible);
        if (sameSlug.length > 1) {
          return {
            answer: `“${invocation.slug}” is in more than one place. Send one of these:`,
            steps: [],
            choices: sameSlug.map((skill) => ({
              label: skillCommand(skill),
              message: `${skillCommand(skill)} ${invocation.rest}`.trim(),
            })),
            skillRun: null,
            expenseDiff: null,
          };
        }
      }

      const skill = resolveSkill(invocation, visible);
      if (!skill) {
        const inNs = invocation.namespace
          ? skillsInNamespace(invocation.namespace, visible)
          : skillsInNamespace(invocation.slug, visible);
        if (!invocation.namespace && inNs.length) {
          return {
            answer: `Skills in ${invocation.slug}:`,
            steps: [],
            choices: inNs.map((item) => ({ label: item.name, message: skillCommand(item) })),
            skillRun: null,
            expenseDiff: null,
          };
        }
        const known = inNs.length
          ? ` Skills in ${invocation.namespace}: ${inNs.map((item) => item.slug).join(', ')}.`
          : '';
        return {
          answer: `No skill matches \`${commandLabel}\`.${known}`,
          steps: [],
          choices: [],
          skillRun: null,
          expenseDiff: null,
        };
      }

      if (skill.slug !== 'expense-reconciliation') {
        const saved = record(skill, {
          conversationId,
          status: 'failed',
          inputs: { rest: invocation.rest },
          error: 'Skill has no runner yet',
        });
        return {
          answer: `\`${skillCommand(skill)}\` is saved but not runnable yet.`,
          steps: [],
          choices: [],
          skillRun: skillRunView(saved),
          expenseDiff: null,
        };
      }

      const command = skillCommand(skill);
      const chatPick = resolveExpenseChat({
        rest: invocation.rest,
        mentions,
        scopeChatJid,
        scopeChatName: scopeChatName || (scopeChatJid ? directory?.name?.(scopeChatJid) : null),
        resolveChat: (query) => directory?.resolve?.(query) || null,
        command,
      });
      const inputs = chatPick.status === 'needs_input'
        ? chatPick
        : resolveExpenseSheet({
          rest: invocation.rest,
          chat: chatPick.chat,
          sheets: sheetsForChat(db, chatPick.chat.chatJid),
          command,
        });

      if (inputs.status === 'needs_input') {
        const saved = record(skill, {
          conversationId,
          status: 'needs_input',
          inputs: { rest: invocation.rest, chatJid: chatPick.chat?.chatJid || null },
          error: null,
        });
        return {
          answer: inputs.answer,
          steps: [`${skillCommand(skill)} needs an input`],
          choices: inputs.choices || [],
          skillRun: skillRunView(saved),
          expenseDiff: null,
        };
      }

      if (!expenseService) {
        const saved = record(skill, {
          conversationId,
          status: 'failed',
          inputs: { chatJid: inputs.chat.chatJid, messageId: inputs.messageId, fileName: inputs.fileName },
          error: 'Expense reconciliation is not enabled on this install.',
        });
        return {
          answer: 'Expense reconciliation is not enabled on this install.',
          steps: [],
          choices: [],
          skillRun: skillRunView(saved),
          expenseDiff: null,
        };
      }

      status?.(`Reconciling ${inputs.chat.chatName || 'the site'} against ${inputs.fileName}…`);
      let expenseRun = null;
      try {
        const provider = typeof resolveProvider === 'function' ? await resolveProvider() : undefined;
        expenseRun = await expenseService.runForChat({
          chatJid: inputs.chat.chatJid,
          messageId: inputs.messageId,
          notifyWhatsApp: false,
          forceRerun: true,
          ...(provider ? { provider } : {}),
        });
      } catch (err) {
        const saved = record(skill, {
          conversationId,
          status: 'failed',
          inputs: { chatJid: inputs.chat.chatJid, messageId: inputs.messageId, fileName: inputs.fileName },
          error: err.message || String(err),
        });
        return {
          answer: `Reconciliation failed: ${err.message || err}`,
          steps: [],
          choices: [],
          skillRun: skillRunView(saved),
          expenseDiff: null,
        };
      }

      if (!expenseRun || expenseRun.status === 'failed') {
        const saved = record(skill, {
          conversationId,
          status: 'failed',
          inputs: { chatJid: inputs.chat.chatJid, messageId: inputs.messageId, fileName: inputs.fileName },
          expenseRunId: expenseRun?.id || null,
          error: expenseRun?.error || 'unknown error',
        });
        return {
          answer: `Reconciliation failed: ${expenseRun?.error || 'unknown error'}`,
          steps: [],
          choices: [],
          skillRun: skillRunView(saved),
          expenseDiff: null,
        };
      }

      const coverage = coverageForRun(db, expenseRun);
      const toolCalls = [
        { tool: 'parse_table', detail: inputs.fileName },
        { tool: 'extract_records', detail: coverage ? `${coverage.messageCount} messages` : null },
        { tool: 'match_records' },
        { tool: 'render_report' },
      ];
      const saved = record(skill, {
        conversationId,
        status: 'dry_run',
        inputs: { chatJid: inputs.chat.chatJid, messageId: inputs.messageId, fileName: inputs.fileName },
        coverage,
        toolCalls,
        expenseRunId: expenseRun.id,
      });
      const { answer, expenseDiff } = summarizeExpenseRun(expenseRun);
      const line = coverageLine(coverage, expenseRun.chatName || inputs.chat.chatName);
      return {
        answer: [answer, line, 'Dry run — nothing was sent to WhatsApp.'].filter(Boolean).join('\n\n'),
        steps: toolCalls.map((call) => call.detail ? `${call.tool}: ${call.detail}` : call.tool),
        choices: [],
        skillRun: skillRunView(saved, { canSend: true }),
        expenseDiff,
      };
    },
  };
}

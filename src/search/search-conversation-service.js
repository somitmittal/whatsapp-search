import { randomUUID } from 'node:crypto';
import { buildReconciledSheetRows } from '../expenses/report-workbook.js';
import { streamChat } from '../llm/stream-chat.js';

const EXPENSE_TERMS = /\b(expense|expenses|voucher|reconcil(?:e|iation)?|discrepanc(?:y|ies)|excel|xlsx|csv|spreadsheet|ledger|petty\s*cash)\b/i;
const COMPARE_TERMS = /\b(compare|check|match|versus|vs\.?|against|diff|difference|summary|today|end of (?:the )?day)\b/i;

export function isExpenseReconcileQuery(query) {
  const q = String(query || '').trim();
  if (!q) return false;
  if (/\b(reconcil|discrepanc)\w*\b/i.test(q)) return true;
  return EXPENSE_TERMS.test(q) && COMPARE_TERMS.test(q);
}

function titleFromQuery(query) {
  const t = String(query || '').trim().replace(/\s+/g, ' ');
  if (t.length <= 72) return t;
  return `${t.slice(0, 69)}…`;
}

function formatAmount(entry) {
  if (!entry || entry.amountMinor == null) return '—';
  const major = Number(entry.amountMinor) / 100;
  const cur = entry.currency || '';
  const n = Number.isFinite(major) ? major.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : String(entry.amountMinor);
  return cur ? `${cur} ${n}` : n;
}

function entryLine(entry) {
  if (!entry) return null;
  const bits = [
    formatAmount(entry),
    entry.direction || null,
    entry.payee || null,
    entry.reference || null,
    entry.description || entry.category || null,
  ].filter(Boolean);
  return bits.join(' · ');
}

function serializeEntry(entry) {
  if (!entry) return null;
  return {
    amount: formatAmount(entry),
    amountMinor: entry.amountMinor,
    currency: entry.currency || '',
    direction: entry.direction || '',
    date: entry.date || '',
    payee: entry.payee || '',
    category: entry.category || '',
    reference: entry.reference || '',
    description: entry.description || '',
    sourceMessageId: entry.sourceMessageId || null,
    sheetRow: entry.sheetRow ?? null,
    line: entryLine(entry),
  };
}

function reconciliationViewFromRun(run) {
  if (Array.isArray(run.matches) && run.matches.length) {
    return {
      matches: run.matches,
      discrepancies: run.discrepancies || [],
      totals: run.totals || {},
    };
  }
  const discrepancies = run.discrepancies || [];
  const sheetIds = new Set(discrepancies.map((d) => d.sheetEntry?.id || d.sheetEntryId).filter(Boolean));
  const chatIds = new Set(discrepancies.map((d) => d.chatEntry?.id || d.chatEntryId).filter(Boolean));
  const usedChat = new Set(chatIds);
  const sheetEntries = (run.entries || []).filter((e) => e.source === 'sheet' && !sheetIds.has(e.id));
  const chatPool = (run.entries || []).filter((e) => e.source === 'chat' && !usedChat.has(e.id));
  const matches = sheetEntries.map((sheetEntry) => {
    const idx = chatPool.findIndex((c) => Number(c.amountMinor) === Number(sheetEntry.amountMinor)
      && (!c.currency || !sheetEntry.currency || c.currency === sheetEntry.currency));
    let chatEntry = null;
    if (idx >= 0) {
      chatEntry = chatPool[idx];
      chatPool.splice(idx, 1);
    }
    return { sheetEntry, chatEntry };
  });
  return {
    matches,
    discrepancies: discrepancies.map((d) => ({
      type: d.type,
      detail: d.detail,
      chatEntry: d.chatEntry || null,
      sheetEntry: d.sheetEntry || null,
    })),
    totals: run.totals || {},
  };
}

function formatMajorAmount(major, currency) {
  if (major === '' || major == null) return null;
  const n = Number(major);
  if (!Number.isFinite(n)) return String(major);
  const text = n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return currency ? `${currency} ${text}` : text;
}

function serializeSheetRow(row) {
  const chat = serializeEntry(row.chatEntry);
  const sheet = serializeEntry(row.sheetEntry);
  const source = sheet || chat;
  const currency = source?.currency || '';
  const toneMap = {
    match: 'match',
    only_sheet: 'extra-sheet',
    missing_sheet: 'missing-sheet',
    mismatch: 'mismatch',
    warn: 'warn',
  };
  return {
    type: row.tone,
    status: row.status,
    rowTone: toneMap[row.tone] || 'warn',
    date: source?.date || '',
    category: source?.category || '',
    payee: source?.payee || '',
    description: source?.description || '',
    reference: source?.reference || '',
    chatAmount: chat?.amount || formatMajorAmount(row.chatAmount, currency),
    sheetAmount: sheet?.amount || formatMajorAmount(row.sheetAmount, currency),
    chat,
    sheet,
  };
}

function summarizeExpenseRun(run) {
  const view = reconciliationViewFromRun(run);
  const totals = view.totals || {};
  const sheetRows = buildReconciledSheetRows(view).map(serializeSheetRow);
  const matched = sheetRows.filter((r) => r.rowTone === 'match').length;
  const red = sheetRows.filter((r) => r.rowTone === 'extra-sheet').length;
  const yellow = sheetRows.filter((r) => r.rowTone === 'missing-sheet').length;
  const amber = sheetRows.filter((r) => r.rowTone === 'mismatch').length;
  const lines = [
    `**${run.chatName || 'Site'}** · ${run.businessDate || 'today'} · ${run.sourceFileName || 'expense sheet'}`,
    `Matched ${matched} · Extra on sheet ${red} · Missing in sheet ${yellow} · Amount differs ${amber}`,
  ];
  if (!red && !yellow && !amber) {
    lines.push('All sheet rows match chat expenses.');
  }
  return {
    answer: lines.join('\n'),
    expenseDiff: {
      runId: run.id,
      chatJid: run.chatJid,
      chatName: run.chatName,
      businessDate: run.businessDate,
      sourceFileName: run.sourceFileName,
      status: run.status,
      error: run.error || null,
      reportAvailable: !!run.reportPath,
      totals: {
        ...totals,
        matchedCount: matched,
        onlySheetCount: red,
        missingSheetCount: yellow,
        mismatchCount: amber,
      },
      sheetRows,
      // keep for follow-ups / older clients
      discrepancies: sheetRows.filter((r) => r.rowTone !== 'match'),
    },
  };
}

function resolveSiteChat(db, query, preferredChatJid) {
  const preferred = String(preferredChatJid || '').trim();
  if (preferred.endsWith('@g.us')) return preferred;

  const sites = typeof db.listExpenseSiteChats === 'function' ? db.listExpenseSiteChats() : [];
  if (!sites.length) return preferred || null;

  const q = String(query || '').toLowerCase();
  const named = sites.find((s) => {
    const name = String(s.chatName || '').toLowerCase();
    return name && q.includes(name);
  });
  if (named) return named.chatJid;

  const siteN = q.match(/\bsite\s*([1-9]\d*)\b/i);
  if (siteN) {
    const needle = `site ${siteN[1]}`;
    const hit = sites.find((s) => String(s.chatName || '').toLowerCase().includes(needle));
    if (hit) return hit.chatJid;
  }

  if (sites.length === 1) return sites[0].chatJid;
  return null;
}

export default class SearchConversationService {
  constructor({ db, searchEngine, expenseService, getProvider }) {
    this.db = db;
    this.searchEngine = searchEngine;
    this.expenseService = expenseService || null;
    this.getProvider = getProvider;
  }

  listRecent(limit = 30) {
    return this.db.listSearchConversations(limit);
  }

  getConversation(id) {
    const conversation = this.db.getSearchConversation(id);
    if (!conversation) return null;
    return {
      conversation,
      messages: this.db.listSearchMessages(id),
    };
  }

  async handleTurn({
    conversationId = null,
    message,
    chatJid = null,
    mediaType = null,
    businessContext = false,
    emit = null,
  }) {
    const text = String(message || '').trim();
    if (!text) throw new Error('message is required');
    const status = (line) => emit?.({ type: 'status', text: line });
    const onDelta = (chunk) => emit?.({ type: 'delta', text: chunk });
    status('Thinking…');

    let conversation = conversationId ? this.db.getSearchConversation(conversationId) : null;
    if (conversationId && !conversation) throw new Error('Conversation not found');

    if (!conversation) {
      conversation = this.db.createSearchConversation({
        id: randomUUID(),
        title: titleFromQuery(text),
        chatJid: chatJid || null,
      });
    } else if (chatJid && !conversation.chatJid) {
      conversation = this.db.touchSearchConversation(conversation.id, { chatJid }) || conversation;
    }

    this.db.addSearchMessage({
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'user',
      content: text,
      payload: { chatJid: chatJid || conversation.chatJid || null },
    });

    const prior = this.db.listSearchMessages(conversation.id);
    const lastExpense = [...prior].reverse().find((m) => m.role === 'assistant' && m.payload?.expenseDiff);

    let assistant;
    if (lastExpense?.payload?.expenseDiff && !isExpenseReconcileQuery(text)) {
      status('Reading the last expense comparison…');
      assistant = await this._followUpExpense(text, lastExpense.payload.expenseDiff, prior, onDelta);
    } else if (isExpenseReconcileQuery(text)) {
      status('Reading the Excel sheet and chat expenses…');
      assistant = await this._runExpenseReconcile(text, chatJid || conversation.chatJid, status, onDelta);
    } else {
      assistant = await this._runSearch(text, chatJid || conversation.chatJid, mediaType, businessContext, prior, status, onDelta);
    }

    this.db.addSearchMessage({
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'assistant',
      content: assistant.answer || '',
      payload: assistant.payload || null,
    });

    if (!conversation.title) {
      this.db.touchSearchConversation(conversation.id, { title: titleFromQuery(text) });
    }

    return {
      conversationId: conversation.id,
      conversation: this.db.getSearchConversation(conversation.id),
      messages: this.db.listSearchMessages(conversation.id),
      answer: assistant.answer,
      sources: assistant.payload?.sources || [],
      expenseDiff: assistant.payload?.expenseDiff || null,
    };
  }

  async _runSearch(query, chatJid, mediaType, businessContext, prior, onStatus, onDelta) {
    const historyHint = prior
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-6)
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');
    const enriched = historyHint && prior.length > 2
      ? `${query}\n\n(Conversation so far:\n${historyHint})`
      : query;
    const result = await this.searchEngine.search(
      enriched,
      chatJid || null,
      mediaType || null,
      { businessContext: !!businessContext, onStatus, onDelta },
    );
    return {
      answer: result.answer || 'No results found.',
      payload: {
        kind: 'search',
        sources: result.sources || [],
        rawQuery: query,
      },
    };
  }

  async _runExpenseReconcile(query, preferredChatJid, onStatus, onDelta) {
    if (!this.expenseService) {
      return {
        answer: 'Expense reconciliation is not available right now.',
        payload: { kind: 'expense_error' },
      };
    }
    const siteJid = resolveSiteChat(this.db, query, preferredChatJid);
    if (!siteJid) {
      const sites = typeof this.db.listExpenseSiteChats === 'function' ? this.db.listExpenseSiteChats() : [];
      const names = sites.map((s) => s.chatName || s.chatJid).filter(Boolean);
      return {
        answer: names.length
          ? `Which site should I reconcile? Open that group chat, or name it in your question (e.g. ${names.slice(0, 3).map((n) => `"${n}"`).join(', ')}).`
          : 'Open a site group chat first, or add sites under Construction expenses in Business settings.',
        payload: { kind: 'expense_need_site', sites },
      };
    }

    onStatus?.('Comparing chat expenses with the sheet…');
    const run = await this.expenseService.runForChat(
      { chatJid: siteJid, notifyWhatsApp: false, forceRerun: true },
      undefined,
    );
    if (!run) {
      return {
        answer: 'Could not run expense reconciliation for that chat.',
        payload: { kind: 'expense_error', chatJid: siteJid },
      };
    }
    if (run.status === 'failed') {
      return {
        answer: `Reconciliation failed: ${run.error || 'unknown error'}`,
        payload: { kind: 'expense_error', runId: run.id, chatJid: siteJid },
      };
    }
    const summarized = summarizeExpenseRun(run);
    onStatus?.('Writing the comparison…');
    if (summarized.answer) onDelta?.(summarized.answer);
    return {
      answer: summarized.answer,
      payload: {
        kind: 'expense_diff',
        expenseDiff: summarized.expenseDiff,
      },
    };
  }

  async _followUpExpense(query, expenseDiff, prior, onDelta) {
    const provider = this.getProvider?.();
    if (!provider?.chat) {
      return {
        answer: 'Configure an AI provider to ask follow-ups about this reconciliation.',
        payload: { kind: 'expense_diff', expenseDiff },
      };
    }
    const rows = expenseDiff.sheetRows || expenseDiff.discrepancies || [];
    const compact = {
      site: expenseDiff.chatName,
      date: expenseDiff.businessDate,
      sheet: expenseDiff.sourceFileName,
      totals: expenseDiff.totals,
      rows: rows.slice(0, 50).map((d) => ({
        status: d.status,
        tone: d.rowTone || d.type,
        category: d.category || null,
        payee: d.payee || null,
        chatAmount: d.chatAmount || null,
        sheetAmount: d.sheetAmount || null,
      })),
    };
    const history = prior.slice(-8).map((m) => `${m.role}: ${m.content}`).join('\n');
    const raw = await streamChat(provider, [
      {
        role: 'system',
        content: 'You help a construction manager read a colored expense sheet vs WhatsApp chat. Green = matched; red = on sheet only; yellow = in chat but missing on sheet; amber = amounts differ. Be concise; cite category/payee and chat vs sheet amounts. Do not invent rows.',
      },
      {
        role: 'user',
        content: `Reconciliation data:\n${JSON.stringify(compact, null, 2)}\n\nRecent conversation:\n${history}\n\nUser question: ${query}`,
      },
    ], { maxTokens: 1200 }, onDelta);
    return {
      answer: String(raw || '').trim() || 'I could not answer that follow-up.',
      payload: { kind: 'expense_diff', expenseDiff },
    };
  }
}

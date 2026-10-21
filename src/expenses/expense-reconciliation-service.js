import { existsSync, mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import config from '../config.js';
import { getCurrentTenantId, runWithTenant } from '../storage/tenant-context.js';
import {
  dayBoundsFromDate,
  dayBoundsFromTimestamp,
  extractChatExpenses,
  inferExpenseHeaders,
} from './chat-expense-extractor.js';
import { parseExpenseSheet } from './sheet-parser.js';
import { looksLikeExpensePdfName } from './pdf-sheet-parser.js';
import { documentExtension, isSupportedSheetExtension } from './document-sheet-parser.js';
import { reconcileExpenses } from './reconciler.js';
import { writeExpenseReport } from './report-workbook.js';
import {
  isConstructionExpenseAgentEnabled,
  isConstructionExpenseSiteAllowed,
} from '../smb/profiles.js';

const REPORT_PREFIX = 'searchable-expense-report-';

/** Live site groups and imported archive chats (manual reconcile / Ask AI). */
export function isExpenseChatJid(chatJid) {
  const jid = String(chatJid || '');
  return jid.endsWith('@g.us') || jid.endsWith('@imported');
}

/**
 * @param {{ strict?: boolean }} [options] strict (auto path on every incoming file) only accepts
 *   spreadsheets and statement-named PDFs; non-strict (user picked the file) accepts any document
 *   or photo the parser can read.
 */
export function isExpenseSheetMessage(row, mediaPath, { strict = true } = {}) {
  if (!row || row.sender === 'You') return false;
  if (!isExpenseChatJid(row.chatJid)) return false;
  const names = [mediaPath, row.text, row.mediaCaption, writtenFileName(row)]
    .map((value) => basename(String(value || '')).toLowerCase())
    .filter(Boolean);
  if (names.some((name) => name.startsWith(REPORT_PREFIX))) return false;
  if (names.some((name) => ['.xlsx', '.csv'].includes(extname(name)))) return true;
  if (names.some((name) => looksLikeExpensePdfName(name))) return true;
  if (strict) return false;
  return isSupportedSheetExtension(documentExtension(writtenFileName(row, mediaPath), mediaPath));
}

const FILE_NAME_EXTENSIONS = 'xlsx|xlsm|csv|tsv|txt|pdf|docx|jpe?g|png|webp';

/** A file name actually written in the message (WhatsApp attachment line or caption), else ''. */
function writtenFileName(row, mediaPath = null) {
  const pattern = new RegExp(`\\.(?:${FILE_NAME_EXTENSIONS})\\b`, 'i');
  const attached = String(row?.text || '').match(/<attached:\s*(?:\d+-)?([^>]+)>/i)?.[1]?.trim();
  if (attached && pattern.test(attached)) return basename(attached);
  const candidate = [row?.mediaCaption, row?.text, mediaPath]
    .map((value) => String(value || '').trim())
    .find((value) => pattern.test(value));
  if (!candidate) return '';
  const match = candidate.match(new RegExp(`([^/\\\\\\s][^/\\\\]*\\.(?:${FILE_NAME_EXTENSIONS}))\\b`, 'i'));
  return basename(match?.[1] || candidate);
}

function originalExpenseFileName(row, mediaPath) {
  return writtenFileName(row, mediaPath) || basename(String(mediaPath || 'expenses.xlsx'));
}

function unreadableChatEntries(rows) {
  return rows.map((row) => ({
    source: 'chat',
    sourceMessageId: row.messageId,
    date: row.date,
    amountMinor: 0,
    currency: 'INR',
    direction: 'debit',
    description: row.text,
    payee: '',
    category: '',
    reference: '',
    sourceText: row.text,
    sourceSender: row.sender,
    rawJson: JSON.stringify({ unreadable: true, sourceText: row.text, sourceSender: row.sender }),
  }));
}

function reportCaption(run, reconciliation) {
  const counts = new Map();
  reconciliation.discrepancies.forEach((item) => counts.set(item.type, (counts.get(item.type) || 0) + 1));
  const lines = [
    `Expense reconciliation — ${run.chatName || 'Site'} — ${run.businessDate}`,
    `Chat entries: ${reconciliation.totals.chatEntryCount} | Sheet rows: ${reconciliation.totals.sheetEntryCount} | Matched: ${reconciliation.totals.matchedCount}`,
  ];
  if (!reconciliation.discrepancies.length) {
    lines.push('No discrepancies found.');
  } else {
    lines.push(`Discrepancies: ${reconciliation.discrepancies.length}`);
    for (const [type, count] of counts) lines.push(`- ${type.replaceAll('_', ' ')}: ${count}`);
    lines.push('See the attached workbook for message evidence and sheet rows.');
  }
  return lines.join('\n');
}

export default class ExpenseReconciliationService {
  constructor({ db, getProvider, getWaClient, onProgress }) {
    this.db = db;
    this.getProvider = getProvider;
    this.getWaClient = getWaClient;
    this.onProgress = typeof onProgress === 'function' ? onProgress : null;
    this._pending = new Map();
    this._reportDir = join(config.dataDir, 'expense-reports');
    mkdirSync(this._reportDir, { recursive: true });
  }

  /**
   * Auto path: only processes sheets posted in allowlisted site groups.
   * @param {string} messageId
   * @param {string} [tenantId]
   */
  enqueueMessage(messageId, tenantId = getCurrentTenantId()) {
    return this._enqueue(messageId, tenantId, { requireSiteAllowlist: true });
  }

  /**
   * Manual path: user picked a chat (and optional sheet). Bypasses the site allowlist.
   * @param {{ chatJid: string, messageId?: string }} input
   * @param {string} [tenantId]
   */
  runForChat({ chatJid, messageId, notifyWhatsApp = true, forceRerun = false, provider = null } = {}, tenantId = getCurrentTenantId()) {
    return runWithTenant(tenantId, async () => {
      if (!isConstructionExpenseAgentEnabled(this.db)) {
        throw new Error('Enable the Construction expense agent first');
      }
      const jid = String(chatJid || '').trim();
      if (!isExpenseChatJid(jid)) throw new Error('Pick a WhatsApp group or imported site chat');
      let mid = String(messageId || '').trim();
      if (!mid) {
        const sheets = this.db.listExpenseSheetMessages?.(jid) || [];
        const latest = sheets.find((sheet) => isExpenseSheetMessage(sheet, sheet.mediaPath))
          || sheets.find((sheet) => isExpenseSheetMessage(sheet, sheet.mediaPath, { strict: false }));
        if (!latest?.messageId) {
          throw new Error('No expense sheet (Excel, CSV, PDF, Word, or text file) found in that chat yet');
        }
        mid = latest.messageId;
      }
      return this._enqueue(mid, tenantId, {
        requireSiteAllowlist: false,
        notifyWhatsApp: notifyWhatsApp !== false,
        forceRerun: !!forceRerun,
        provider,
      });
    });
  }

  _enqueue(messageId, tenantId, {
    requireSiteAllowlist,
    notifyWhatsApp = true,
    forceRerun = false,
    provider = null,
  }) {
    if (!messageId) return null;
    const providerKey = provider ? `${provider.name || 'provider'}:${provider.model || ''}` : 'default';
    const key = `${tenantId}:${messageId}:${providerKey}`;
    if (this._pending.has(key)) return this._pending.get(key);
    const promise = runWithTenant(tenantId, async () => {
      try {
        return await this._processMessage(messageId, {
          requireSiteAllowlist,
          notifyWhatsApp,
          forceRerun,
          provider,
        });
      } finally {
        this._pending.delete(key);
      }
    });
    this._pending.set(key, promise);
    return promise;
  }

  recoverPending(tenantId = getCurrentTenantId()) {
    return runWithTenant(tenantId, () => {
      const jobs = [];
      for (const run of this.db.listRecoverableExpenseRuns()) {
        if (run.status === 'processing') this.db.resetExpenseReconciliationRun(run.id);
        const job = this.enqueueMessage(run.sourceMessageId, tenantId);
        if (job) jobs.push(job);
      }
      return Promise.all(jobs);
    });
  }

  /**
   * Post an already-written dry-run report. Does not reconcile again.
   */
  sendCompletedReport(runId, tenantId = getCurrentTenantId()) {
    return runWithTenant(tenantId, async () => {
      const run = this.db.getExpenseReconciliationRun(runId);
      if (!run) throw new Error('Expense reconciliation run not found');
      if (run.reportMessageId) return run;
      if (run.status !== 'completed' || !run.reportPath || !existsSync(run.reportPath)) {
        throw new Error('Report is not ready to send');
      }
      const waClient = this.getWaClient?.(getCurrentTenantId());
      if (!waClient?.sendDocument) throw new Error('WhatsApp is not connected; the report is ready to download');
      const sent = await waClient.sendDocument(run.chatJid, run.reportPath, {
        fileName: basename(run.reportPath),
        caption: reportCaption(run, {
          discrepancies: run.discrepancies || [],
          totals: run.totals || {},
        }),
      });
      this.db.updateExpenseReconciliationRun(run.id, {
        status: 'completed',
        reportMessageId: sent?.key?.id || null,
        error: null,
      });
      this._emit(run.id, 'completed');
      return this.db.getExpenseReconciliationRun(run.id);
    });
  }

  retryRun(runId, tenantId = getCurrentTenantId()) {
    return runWithTenant(tenantId, () => {
      const run = this.db.getExpenseReconciliationRun(runId);
      if (!run) throw new Error('Expense reconciliation run not found');
      this.db.resetExpenseReconciliationRun(runId);
      return this._enqueue(run.sourceMessageId, tenantId, { requireSiteAllowlist: false });
    });
  }

  /**
   * Chat messages a sheet should account for: its date span, but not before the previous
   * sheet was posted (those payments belong to that sheet) and not after this one was posted.
   */
  _chatMessages(sheetRow, firstDate, lastDate) {
    const startTs = dayBoundsFromDate(firstDate).startTs;
    const lastDay = dayBoundsFromDate(lastDate);
    let endTs = lastDay.endTs;
    const postedAt = Number(sheetRow.timestamp);
    // Posted on its last day (the usual evening hisab): later messages belong to the next sheet.
    if (Number.isFinite(postedAt) && postedAt >= lastDay.startTs && postedAt < endTs) endTs = postedAt;
    const messages = this.db.getMessagesByTimeRange(sheetRow.chatJid, startTs, endTs) || [];
    // The previous sheet message may have no stored file (imports often omit media), so look at messages.
    const previous = [...messages].reverse().find((message) => (
      message.messageId !== sheetRow.messageId
      && Number(message.timestamp) < postedAt
      && isExpenseSheetMessage({ ...message, chatJid: message.chatJid || sheetRow.chatJid }, message.mediaPath)
    ));
    return previous ? messages.filter((message) => Number(message.timestamp) > Number(previous.timestamp)) : messages;
  }

  _emit(runId, status, extra = {}) {
    this.onProgress?.({ runId, status, ...extra }, getCurrentTenantId());
  }

  async _processMessage(messageId, {
    requireSiteAllowlist = true,
    notifyWhatsApp = true,
    forceRerun = false,
    provider: providerOverride = null,
  } = {}) {
    if (!isConstructionExpenseAgentEnabled(this.db)) return null;
    const row = this.db.getMessageRowByMessageId(messageId);
    const media = this.db.getMessageMediaRecord(messageId);
    const mediaPath = media?.mediaPath;
    if (!mediaPath || !existsSync(mediaPath)
      || !isExpenseSheetMessage(row, mediaPath, { strict: requireSiteAllowlist })) return null;
    if (requireSiteAllowlist && !isConstructionExpenseSiteAllowed(this.db, row.chatJid)) return null;

    const bounds = dayBoundsFromTimestamp(row.timestamp);
    const sourceFileName = originalExpenseFileName(row, mediaPath);
    let run = this.db.createExpenseReconciliationRun({
      chatJid: row.chatJid,
      chatName: row.chatName,
      sourceMessageId: messageId,
      sourceFileName,
      sourceMediaPath: mediaPath,
      businessDate: bounds.date,
    });
    if (!run) return null;
    if (run.status === 'processing') {
      return this.db.getExpenseReconciliationRun(run.id);
    }
    if (run.status === 'completed' && !forceRerun) {
      return this.db.getExpenseReconciliationRun(run.id);
    }
    if (forceRerun || ['failed', 'sending', 'queued'].includes(run.status)) {
      this.db.resetExpenseReconciliationRun(run.id);
      run = this.db.getExpenseReconciliationRun(run.id) || run;
    }

    this.db.updateExpenseReconciliationRun(run.id, { status: 'processing', error: null });
    this._emit(run.id, 'processing');
    try {
      const provider = providerOverride || this.getProvider?.();
      if (!provider?.chat) throw new Error('Configure an AI provider before reconciling expenses');
      const parsedSheet = await parseExpenseSheet(mediaPath, {
        fallbackDate: bounds.date,
        fileName: sourceFileName,
        provider,
        inferHeaders: (headers, fields) => inferExpenseHeaders(provider, headers, fields),
      });
      const sheetDates = parsedSheet.entries.map((entry) => entry.date).filter(Boolean).sort();
      const firstDate = sheetDates[0] || bounds.date;
      const lastDate = sheetDates[sheetDates.length - 1] || firstDate;
      const businessDate = firstDate === lastDate ? firstDate : `${firstDate} – ${lastDate}`;
      const messages = this._chatMessages(row, firstDate, lastDate);
      let unreadable = [];
      const chatEntries = await extractChatExpenses(provider, messages, {
        date: firstDate,
        excludedMessageId: messageId,
        onUnreadable: (rows) => { unreadable = unreadableChatEntries(rows); },
      });
      const reconciliation = reconcileExpenses(chatEntries, parsedSheet.entries);
      for (const entry of unreadable) {
        reconciliation.discrepancies.push({
          type: 'needs_review',
          chatEntry: entry,
          sheetEntry: null,
          detail: 'Payment message whose amount could not be read safely — check it against the sheet',
        });
      }
      reconciliation.totals = {
        ...reconciliation.totals,
        chatEntryCount: chatEntries.length,
        sheetEntryCount: parsedSheet.entries.length,
        matchedCount: reconciliation.matches.length,
        discrepancyCount: reconciliation.discrepancies.length,
      };

      this.db.replaceExpenseReconciliationData(
        run.id,
        [...chatEntries, ...unreadable, ...parsedSheet.entries],
        reconciliation.discrepancies,
      );
      const reportName = `${REPORT_PREFIX}${run.id}.xlsx`;
      const reportPath = join(this._reportDir, reportName);
      await writeExpenseReport(reportPath, {
        siteName: row.chatName,
        date: businessDate,
        sourceFileName,
        chatEntries,
        sheetEntries: parsedSheet.entries,
        reconciliation,
        sheetHeaders: parsedSheet.headers,
        sheetMapping: parsedSheet.mapping,
      });

      if (!notifyWhatsApp) {
        this.db.updateExpenseReconciliationRun(run.id, {
          status: 'completed',
          businessDate,
          reportPath,
          totals: reconciliation.totals,
          error: null,
        });
        this._emit(run.id, 'completed');
        return this.db.getExpenseReconciliationRun(run.id);
      }

      this.db.updateExpenseReconciliationRun(run.id, {
        status: 'sending',
        businessDate,
        reportPath,
        totals: reconciliation.totals,
        error: null,
      });
      this._emit(run.id, 'sending');

      const waClient = this.getWaClient?.(getCurrentTenantId());
      if (!waClient?.sendDocument) throw new Error('WhatsApp is not connected; report is ready to retry');
      const sent = await waClient.sendDocument(row.chatJid, reportPath, {
        fileName: reportName,
        caption: reportCaption({ ...run, businessDate }, reconciliation),
      });
      this.db.updateExpenseReconciliationRun(run.id, {
        status: 'completed',
        businessDate,
        reportPath,
        reportMessageId: sent?.key?.id || null,
        totals: reconciliation.totals,
        error: null,
      });
      this._emit(run.id, 'completed');
      return this.db.getExpenseReconciliationRun(run.id);
    } catch (error) {
      this.db.updateExpenseReconciliationRun(run.id, {
        status: 'failed',
        error: error.message || String(error),
      });
      this._emit(run.id, 'failed', { error: error.message || String(error) });
      console.warn(`[Expenses] ${messageId}:`, error.message || error);
      return this.db.getExpenseReconciliationRun(run.id);
    }
  }
}


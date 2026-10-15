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
import { parseExpenseWorkbook } from './sheet-parser.js';
import { reconcileExpenses } from './reconciler.js';
import { writeExpenseReport } from './report-workbook.js';
import { isConstructionExpenseAgentEnabled } from '../smb/profiles.js';

const REPORT_PREFIX = 'searchable-expense-report-';

export function isExpenseSheetMessage(row, mediaPath) {
  if (!row || row.sender === 'You') return false;
  if (!String(row.chatJid || '').endsWith('@g.us')) return false;
  const names = [mediaPath, row.text, row.mediaCaption]
    .map((value) => basename(String(value || '')).toLowerCase())
    .filter(Boolean);
  if (names.some((name) => name.startsWith(REPORT_PREFIX))) return false;
  return names.some((name) => ['.xlsx', '.csv'].includes(extname(name)));
}

function originalExpenseFileName(row, mediaPath) {
  const candidate = [row?.mediaCaption, row?.text, mediaPath]
    .map((value) => String(value || '').trim())
    .find((value) => /\.(xlsx|csv)\b/i.test(value));
  if (!candidate) return basename(String(mediaPath || 'expenses.xlsx'));
  const match = candidate.match(/([^/\\\s][^/\\]*\.(?:xlsx|csv))\b/i);
  return basename(match?.[1] || candidate);
}

function reportCaption(run, reconciliation) {
  const counts = new Map();
  reconciliation.discrepancies.forEach((item) => counts.set(item.type, (counts.get(item.type) || 0) + 1));
  const lines = [
    `Expense reconciliation — ${run.chatName || 'Construction site'} — ${run.businessDate}`,
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

  enqueueMessage(messageId, tenantId = getCurrentTenantId()) {
    if (!messageId) return null;
    const key = `${tenantId}:${messageId}`;
    if (this._pending.has(key)) return this._pending.get(key);
    const promise = runWithTenant(tenantId, async () => {
      try {
        return await this._processMessage(messageId);
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

  retryRun(runId, tenantId = getCurrentTenantId()) {
    return runWithTenant(tenantId, () => {
      const run = this.db.getExpenseReconciliationRun(runId);
      if (!run) throw new Error('Expense reconciliation run not found');
      this.db.resetExpenseReconciliationRun(runId);
      return this.enqueueMessage(run.sourceMessageId, tenantId);
    });
  }

  _emit(runId, status, extra = {}) {
    this.onProgress?.({ runId, status, ...extra }, getCurrentTenantId());
  }

  async _processMessage(messageId) {
    if (!isConstructionExpenseAgentEnabled(this.db)) return null;
    const row = this.db.getMessageRowByMessageId(messageId);
    const media = this.db.getMessageMediaRecord(messageId);
    const mediaPath = media?.mediaPath;
    if (!mediaPath || !existsSync(mediaPath) || !isExpenseSheetMessage(row, mediaPath)) return null;

    const bounds = dayBoundsFromTimestamp(row.timestamp);
    const sourceFileName = originalExpenseFileName(row, mediaPath);
    const run = this.db.createExpenseReconciliationRun({
      chatJid: row.chatJid,
      chatName: row.chatName,
      sourceMessageId: messageId,
      sourceFileName,
      sourceMediaPath: mediaPath,
      businessDate: bounds.date,
    });
    if (!run || ['completed', 'processing'].includes(run.status)) return run;

    this.db.updateExpenseReconciliationRun(run.id, { status: 'processing', error: null });
    this._emit(run.id, 'processing');
    try {
      const provider = this.getProvider?.();
      if (!provider?.chat) throw new Error('Configure an AI provider before reconciling expenses');
      const parsedSheet = await parseExpenseWorkbook(mediaPath, {
        fallbackDate: bounds.date,
        fileName: sourceFileName,
        inferHeaders: (headers, fields) => inferExpenseHeaders(provider, headers, fields),
      });
      const businessDate = parsedSheet.entries.find((entry) => entry.date)?.date || bounds.date;
      const businessBounds = dayBoundsFromDate(businessDate);
      const messages = this.db.getMessagesByTimeRange(
        row.chatJid,
        businessBounds.startTs,
        businessBounds.endTs,
      );
      const chatEntries = await extractChatExpenses(provider, messages, {
        date: businessDate,
        excludedMessageId: messageId,
      });
      const reconciliation = reconcileExpenses(chatEntries, parsedSheet.entries);
      reconciliation.totals = {
        ...reconciliation.totals,
        chatEntryCount: chatEntries.length,
        sheetEntryCount: parsedSheet.entries.length,
        matchedCount: reconciliation.matches.length,
        discrepancyCount: reconciliation.discrepancies.length,
      };

      this.db.replaceExpenseReconciliationData(
        run.id,
        [...chatEntries, ...parsedSheet.entries],
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
      });
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


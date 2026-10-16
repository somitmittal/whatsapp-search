import { esc, escAttr } from './util.js';

export function renderExpenseDiff(diff) {
  const rows = diff.sheetRows || diff.discrepancies || [];
  const totals = diff.totals || {};
  const matched = totals.matchedCount ?? rows.filter((r) => r.rowTone === 'match').length;
  const red = totals.onlySheetCount ?? rows.filter((r) => r.rowTone === 'extra-sheet').length;
  const yellow = totals.missingSheetCount ?? rows.filter((r) => r.rowTone === 'missing-sheet' || r.rowTone === 'extra-chat').length;
  const amber = totals.mismatchCount ?? rows.filter((r) => r.rowTone === 'mismatch').length;
  let html = `<div class="expense-diff expense-sheet">
    <div class="expense-diff-head">
      <div class="expense-diff-title">${esc(diff.chatName || 'Site')} · ${esc(diff.businessDate || '')}</div>
      <div class="expense-diff-meta">${esc(diff.sourceFileName || 'Expense sheet')} · Matched ${matched} · Extra ${red} · Missing ${yellow} · Differs ${amber}</div>
    </div>`;
  if (diff.reportAvailable && diff.runId) {
    html += `<a class="expense-diff-report" href="/api/expenses/runs/${encodeURIComponent(diff.runId)}/report">Download colored Excel sheet</a>`;
  }
  if (!rows.length) {
    html += `<div class="expense-diff-ok">No expense rows to show.</div></div>`;
    return html;
  }
  html += `<div class="expense-sheet-scroll"><table class="expense-sheet-table">
    <thead><tr>
      <th>Date</th><th>Category</th><th>Payee</th><th>Description</th>
      <th>Chat amount</th><th>Sheet amount</th><th>Status</th>
    </tr></thead><tbody>`;
  for (const d of rows) {
    let tone = d.rowTone || 'warn';
    if (tone === 'extra-chat') tone = 'missing-sheet';
    if (d.type === 'missing_from_sheet') tone = 'missing-sheet';
    if (d.type === 'only_in_sheet') tone = 'extra-sheet';
    if (d.type === 'amount_mismatch') tone = 'mismatch';
    if (d.type === 'match') tone = 'match';
    const status = d.status
      || (tone === 'missing-sheet' ? 'Missing in sheet'
        : tone === 'extra-sheet' ? 'Extra on sheet (not in chat)'
          : tone === 'mismatch' ? 'Amount differs'
            : tone === 'match' ? 'Matched'
              : (d.detail || 'Review'));
    const chatAmt = d.chatAmount || d.chat?.amount || '—';
    const sheetAmt = d.sheetAmount || d.sheet?.amount || '—';
    html += `<tr class="expense-row expense-row-${escAttr(tone)}">
      <td>${esc(d.date || d.chat?.date || d.sheet?.date || '—')}</td>
      <td>${esc(d.category || d.chat?.category || d.sheet?.category || '—')}</td>
      <td>${esc(d.payee || d.chat?.payee || d.sheet?.payee || '—')}</td>
      <td>${esc(d.description || d.chat?.description || d.sheet?.description || '—')}</td>
      <td class="expense-amt">${esc(chatAmt)}</td>
      <td class="expense-amt">${esc(sheetAmt)}</td>
      <td class="expense-status">${esc(status)}</td>
    </tr>`;
  }
  html += `</tbody></table></div>
    <div class="expense-sheet-legend">
      <span class="leg leg-match">Green — matched</span>
      <span class="leg leg-sheet">Red — extra on sheet</span>
      <span class="leg leg-missing">Yellow — missing in sheet</span>
      <span class="leg leg-mismatch">Amber — amount differs</span>
    </div>
  </div>`;
  return html;
}

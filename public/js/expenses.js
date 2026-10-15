import { store } from './store.js';
import { openChat } from './chat-view.js';
import { closeOverlay } from './overlays.js';
import { $, esc, escAttr } from './util.js';

function expenseMoney(minor, currency = 'INR') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(minor || 0) / 100);
  } catch {
    return `${currency} ${(Number(minor || 0) / 100).toFixed(2)}`;
  }
}

function renderExpenseRuns() {
  const root = $('#expense-runs');
  if (!root) return;
  const site = $('#expense-site-filter')?.value || '';
  const date = $('#expense-date-filter')?.value || '';
  const status = $('#expense-status-filter')?.value || '';
  const rows = store.expenseRuns.filter((run) => (
    (!site || run.chatJid === site)
    && (!date || run.businessDate === date)
    && (!status || run.status === status)
  ));
  if (!rows.length) {
    root.innerHTML = '<div class="expense-empty">No reconciliations match these filters.</div>';
    return;
  }
  root.innerHTML = rows.map((run) => {
    const totals = run.totals || {};
    return `<div class="expense-run" data-expense-run="${run.id}">
        <div class="expense-run-head">
          <div><div class="expense-run-title">${esc(run.chatName || run.chatJid)}</div>
          <div class="expense-run-meta">${esc(run.businessDate || 'Date pending')} · ${esc(run.sourceFileName || 'Expense sheet')}
          ${totals.discrepancyCount != null ? ` · ${totals.discrepancyCount} discrepancies` : ''}</div></div>
          <span class="expense-badge ${escAttr(run.status)}">${esc(run.status)}</span>
        </div>
        <div class="expense-run-detail"></div>
      </div>`;
  }).join('');
}

export async function loadExpenseRuns() {
  const root = $('#expense-runs');
  if (root) root.innerHTML = '<div class="expense-empty">Loading reconciliations…</div>';
  try {
    const response = await fetch('/api/expenses/runs');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to load reconciliations');
    store.expenseRuns = data.runs || [];
    const siteSelect = $('#expense-site-filter');
    if (siteSelect) {
      const selected = siteSelect.value;
      const sites = new Map(store.expenseRuns.map((run) => [run.chatJid, run.chatName || run.chatJid]));
      siteSelect.innerHTML = '<option value="">All sites</option>'
        + [...sites].map(([jid, name]) => `<option value="${escAttr(jid)}">${esc(name)}</option>`).join('');
      siteSelect.value = sites.has(selected) ? selected : '';
    }
    renderExpenseRuns();
  } catch (error) {
    if (root) root.innerHTML = `<div class="expense-empty">${esc(error.message)}</div>`;
  }
}

function expenseEntryHtml(entry) {
  if (!entry) return '<span style="color:var(--text2)">—</span>';
  const label = entry.payee || entry.description || entry.reference || 'Expense';
  return `<strong>${esc(expenseMoney(entry.amountMinor, entry.currency))}</strong><br>${esc(label)}
      ${entry.sheetRow ? `<br><span style="color:var(--text2)">Sheet row ${entry.sheetRow}</span>` : ''}
      ${entry.sourceMessageId ? `<br><button class="expense-evidence" data-expense-mid="${escAttr(entry.sourceMessageId)}">View message</button>` : ''}`;
}

async function loadExpenseRunDetail(container, runId) {
  container.innerHTML = '<div class="expense-detail">Loading details…</div>';
  const response = await fetch(`/api/expenses/runs/${encodeURIComponent(runId)}`);
  const run = await response.json();
  if (!response.ok) {
    container.innerHTML = `<div class="expense-detail">${esc(run.error || 'Failed')}</div>`;
    return;
  }
  const totals = run.totals || {};
  const actions = [
    run.reportPath ? `<a class="btn btn-secondary" href="/api/expenses/runs/${run.id}/report">Download report</a>` : '',
    run.status === 'failed' ? `<button class="btn btn-primary" data-expense-retry="${run.id}">Retry</button>` : '',
  ].filter(Boolean).join(' ');
  container.innerHTML = `<div class="expense-detail">
      <div class="expense-summary-grid">
        <div class="expense-stat">Chat entries<strong>${totals.chatEntryCount ?? 0}</strong></div>
        <div class="expense-stat">Sheet rows<strong>${totals.sheetEntryCount ?? 0}</strong></div>
        <div class="expense-stat">Matched<strong>${totals.matchedCount ?? 0}</strong></div>
        <div class="expense-stat">Discrepancies<strong>${totals.discrepancyCount ?? run.discrepancies.length}</strong></div>
      </div>
      ${run.error ? `<p style="color:#d93025">${esc(run.error)}</p>` : ''}
      <div style="display:flex;gap:8px;margin-bottom:10px">${actions}</div>
      ${run.discrepancies.length ? run.discrepancies.map((item) => `
        <div class="expense-diff">
          <div><div class="expense-diff-type">${esc(item.type.replaceAll('_', ' '))}</div>
          <div style="color:var(--text2)">${esc(item.detail || '')}</div>
          ${item.resolution ? `<div style="color:var(--green)">Resolved: ${esc(item.resolution)}</div>` : `<button class="expense-evidence" data-expense-resolve="${item.id}">Mark resolved</button>`}</div>
          <div>${expenseEntryHtml(item.chatEntry)}</div>
          <div>${expenseEntryHtml(item.sheetEntry)}</div>
        </div>`).join('') : '<div class="expense-empty">No discrepancies found.</div>'}
    </div>`;
  container.dataset.chatJid = run.chatJid;
}

export function initExpenses() {
  $('#expense-refresh')?.addEventListener('click', loadExpenseRuns);
  $('#expense-site-filter')?.addEventListener('change', renderExpenseRuns);
  $('#expense-date-filter')?.addEventListener('change', renderExpenseRuns);
  $('#expense-status-filter')?.addEventListener('change', renderExpenseRuns);

  $('#expense-runs')?.addEventListener('click', async (event) => {
    const evidence = event.target.closest('[data-expense-mid]');
    if (evidence) {
      const detail = evidence.closest('.expense-run-detail');
      closeOverlay('expenses');
      await openChat(detail?.dataset.chatJid, evidence.getAttribute('data-expense-mid'));
      return;
    }
    const retry = event.target.closest('[data-expense-retry]');
    if (retry) {
      await fetch(`/api/expenses/runs/${retry.getAttribute('data-expense-retry')}/retry`, { method: 'POST' });
      await loadExpenseRuns();
      return;
    }
    const resolveButton = event.target.closest('[data-expense-resolve]');
    if (resolveButton) {
      await fetch(`/api/expenses/discrepancies/${resolveButton.getAttribute('data-expense-resolve')}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution: 'reviewed' }),
      });
      const host = resolveButton.closest('.expense-run');
      await loadExpenseRunDetail(host.querySelector('.expense-run-detail'), host.getAttribute('data-expense-run'));
      return;
    }
    const head = event.target.closest('.expense-run-head');
    if (!head) return;
    const host = head.closest('.expense-run');
    const detail = host.querySelector('.expense-run-detail');
    if (detail.innerHTML) detail.innerHTML = '';
    else await loadExpenseRunDetail(detail, host.getAttribute('data-expense-run'));
  });
}

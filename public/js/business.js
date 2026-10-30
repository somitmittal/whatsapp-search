import { store } from './store.js';
import { openChat } from './chat-view.js';
import { SEARCH_INPUT_PLACEHOLDER_DEFAULT, SMB_PLACEHOLDERS } from './constants.js';
import { messageTimestampToDate } from './format.js';
import { openSearchAssistant } from './search.js';
import { $, esc, escAttr } from './util.js';

export function smbSearchPlaceholder() {
  return SMB_PLACEHOLDERS[store.smbState.profile] || SEARCH_INPUT_PLACEHOLDER_DEFAULT;
}

export function isSmbBusinessMode() {
  return store.smbState.profile && store.smbState.profile !== 'personal';
}

export function applySmbUi() {
  const tab = $('#sidebar-tab-business');
  const prompts = $('#smb-prompts');
  const nameRow = $('#smb-business-name-row');
  const on = isSmbBusinessMode();
  const showBusinessChrome = on && store.sidebarListTab === 'business';
  if (tab) tab.hidden = !on;
  if (prompts) prompts.classList.toggle('visible', showBusinessChrome);
  if (nameRow) nameRow.style.display = on ? '' : 'none';
  renderSmbPrompts();
  if (showBusinessChrome) void loadBusinessInbox();
  const welcomeLead = $('#welcome-default-lead');
  if (welcomeLead) {
    welcomeLead.innerHTML = on
      ? 'Import customer chats with <strong>+</strong>, then use <strong>Business</strong> in the sidebar or the quick chips above.<br>Open a chat and tap the purple sparkle to ask AI.'
      : 'Select a chat from the left, then tap the purple sparkle to ask AI.<br>Click <strong>+</strong> to import more chat exports.';
  }
}

function renderSmbPrompts() {
  const root = $('#smb-prompts');
  if (!root) return;
  if (!isSmbBusinessMode()) {
    root.innerHTML = '';
    return;
  }
  root.innerHTML = (store.smbState.prompts || []).map((p) =>
    `<button type="button" class="smb-prompt-chip" data-smb-query="${escAttr(p.query)}">${esc(p.label)}</button>`,
  ).join('');
}

function renderSmbMismatchBanner(data) {
  const el = $('#smb-mismatch-banner');
  if (!el) return;
  if (data?.dataMismatch && data.mismatchReason) {
    el.textContent = data.mismatchReason;
    el.classList.add('visible');
    el.hidden = false;
  } else {
    el.textContent = '';
    el.classList.remove('visible');
    el.hidden = true;
  }
}

export async function loadSmbProfile() {
  try {
    const data = await fetch('/api/smb/profile').then((r) => r.json());
    store.smbState = {
      profile: 'personal',
      businessName: '',
      prompts: [],
      expenseAgentEnabled: true,
      expenseSiteJids: Array.isArray(data.expenseSiteJids) ? data.expenseSiteJids : [],
    };
    syncSmbAgentCards();
    void loadExpenseSitePicker();
    renderSmbMismatchBanner({ dataMismatch: false });
    applySmbUi();
  } catch { /* ignore */ }
}

function selectedExpenseSiteJids() {
  return [...document.querySelectorAll('#smb-expense-sites input[type="checkbox"]:checked')]
    .map((el) => el.value)
    .filter(Boolean);
}

async function loadExpenseSitePicker() {
  const list = $('#smb-expense-sites');
  const runChat = $('#smb-expense-run-chat');
  if (!list || !runChat) return;
  try {
    const data = await fetch('/api/expenses/sites').then((r) => r.json());
    const sites = Array.isArray(data.sites) ? data.sites : [];
    const selected = new Set(
      Array.isArray(data.selectedJids) ? data.selectedJids : (store.smbState.expenseSiteJids || []),
    );
    const liveSites = sites.filter((s) => !s.imported && String(s.chatJid || '').endsWith('@g.us'));
    if (!liveSites.length) {
      list.innerHTML = '<div class="smb-agent-hint" style="margin:0;">No live WhatsApp groups indexed yet. Link WhatsApp or wait for groups to sync. Imported chats still appear in Run below.</div>';
    } else {
      list.innerHTML = liveSites.map((s) => `
        <label class="smb-agent-site">
          <input type="checkbox" value="${escAttr(s.chatJid)}"${selected.has(s.chatJid) ? ' checked' : ''} />
          <span>${esc(s.chatName || s.chatJid)}</span>
        </label>
      `).join('');
    }
    const prev = runChat.value;
    runChat.innerHTML = '<option value="">Select a group or import…</option>'
      + sites.map((s) => {
        const tag = s.imported ? ' (imported)' : '';
        return `<option value="${escAttr(s.chatJid)}">${esc((s.chatName || s.chatJid) + tag)}</option>`;
      }).join('');
    if (prev && sites.some((s) => s.chatJid === prev)) runChat.value = prev;
  } catch (err) {
    list.innerHTML = `<div class="smb-agent-hint" style="margin:0;">${esc(err.message || 'Could not load sites')}</div>`;
  }
}

async function loadExpenseSheetsForRunChat() {
  const chatJid = $('#smb-expense-run-chat')?.value || '';
  const sheetSel = $('#smb-expense-run-sheet');
  if (!sheetSel) return;
  sheetSel.innerHTML = '<option value="">Latest sheet in chat</option>';
  if (!chatJid) return;
  try {
    const data = await fetch(`/api/expenses/sheets?chatJid=${encodeURIComponent(chatJid)}`).then((r) => r.json());
    for (const sheet of data.sheets || []) {
      const when = formatBizTs(sheet.timestamp);
      const label = `${sheet.fileName || 'sheet'}${when ? ` · ${when}` : ''}`;
      const opt = document.createElement('option');
      opt.value = sheet.messageId;
      opt.textContent = label;
      sheetSel.appendChild(opt);
    }
  } catch { /* keep latest default */ }
}

function formatBizTs(ts) {
  if (!ts) return '';
  const d = messageTimestampToDate(ts);
  if (!d) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

export async function loadBusinessInbox() {
  const root = $('#business-inbox-panel');
  if (!root || !isSmbBusinessMode()) return;
  root.innerHTML = '<div class="biz-empty"><span class="spinner" style="width:16px;height:16px;"></span> Loading…</div>';
  try {
    const isClinic = store.smbState.profile === 'clinic';
    const [data, apptData] = await Promise.all([
      fetch('/api/smb/inbox').then((r) => r.json()),
      isClinic ? fetch('/api/smb/appointments').then((r) => r.json()) : Promise.resolve(null),
    ]);
    if (!data.enabled) {
      root.innerHTML = '<div class="biz-empty">Set a business profile in Settings to use the business inbox.</div>';
      return;
    }
    const title = data.businessName || data.profile?.label || 'Business';
    let html = `<div class="biz-section"><h4>${esc(title)}</h4><p class="biz-empty" style="padding:0 0 8px;">${esc(data.profile?.tagline || '')}</p></div>`;

    if (isClinic && apptData?.enabled) {
      html += '<div class="biz-section"><h4>Appointment board</h4>';
      const appts = apptData.appointments || [];
      if (appts.length) {
        for (const a of appts.slice(0, 12)) {
          const st = ['requested', 'confirmed', 'cancelled'].includes(a.status) ? a.status : 'other';
          const stCls = st === 'other' ? '' : ` biz-appt-status ${st}`;
          html += `<div class="biz-card" data-biz-jid="${escAttr(a.chatJid)}">
              <div class="biz-card-title">${esc(a.patientName || a.chatName || 'Patient')}${st !== 'other' ? `<span class="biz-appt-status ${st}">${esc(a.status)}</span>` : ''}</div>
              ${a.when ? `<div class="biz-card-meta">${esc(a.when)}</div>` : ''}
              <div class="biz-card-snippet">${esc(a.summary || a.reason || '')}</div>
            </div>`;
        }
      } else {
        html += '<div class="biz-empty">No appointments indexed yet. Import chats and run <strong>Generate Summaries</strong>.</div>';
      }
      html += '</div>';
    }

    html += '<div class="biz-section"><h4>Awaiting reply</h4>';
    if (data.awaitingReply?.length) {
      for (const row of data.awaitingReply) {
        html += `<div class="biz-card" data-biz-jid="${escAttr(row.chatJid)}">
            <div class="biz-card-title">${esc(row.chatName || row.lastSender)}</div>
            <div class="biz-card-meta">${esc(formatBizTs(row.lastMessageTs))}</div>
            <div class="biz-card-snippet">${esc(row.lastText || '')}</div>
          </div>`;
      }
    } else {
      html += '<div class="biz-empty">No customer chats waiting on you right now.</div>';
    }
    html += '</div>';

    html += '<div class="biz-section"><h4>Suggested follow-ups</h4>';
    if (data.followUps?.length) {
      for (const row of data.followUps.slice(0, 8)) {
        const item = row.items?.[0] || '';
        html += `<div class="biz-card" data-biz-jid="${escAttr(row.chatJid)}"${row.sourceMessageId ? ` data-biz-mid="${escAttr(row.sourceMessageId)}"` : ''}>
            <div class="biz-card-title">${esc(row.chatName || 'Chat')}</div>
            <div class="biz-card-snippet">${esc(item)}</div>
            ${row.snippet ? `<div class="biz-card-meta">${esc(row.snippet)}</div>` : ''}
          </div>`;
      }
    } else {
      html += '<div class="biz-empty">Follow-ups appear as new customer messages are indexed.</div>';
    }
    html += '</div>';

    html += '<div class="biz-section"><h4>Recent highlights</h4>';
    if (data.highlights?.length) {
      for (const h of data.highlights.slice(0, 6)) {
        html += `<div class="biz-card" data-biz-jid="${escAttr(h.chatJid)}">
            <div class="biz-card-title">${esc(h.chatName || h.factType)}</div>
            <div class="biz-card-meta">${esc(h.factType)}</div>
            <div class="biz-card-snippet">${esc(h.summary || '')}</div>
          </div>`;
      }
    } else {
      html += '<div class="biz-empty">Run <strong>Generate Summaries</strong> in Settings to extract appointments, orders, and payments.</div>';
    }
    html += '</div>';

    root.innerHTML = html;
  } catch (err) {
    root.innerHTML = `<div class="biz-empty">${esc(err.message)}</div>`;
  }
}

function syncSmbAgentCards() {
  const card = $('#smb-agents-construction');
  if (card) card.hidden = false;
}

export async function loadWabaConfig() {
  try {
    const data = await fetch('/api/waba/config').then((r) => r.json());
    const urlEl = $('#waba-webhook-url');
    if (urlEl) urlEl.textContent = data.webhookUrl || '—';
    const pid = $('#waba-phone-id');
    if (pid) pid.value = data.phoneNumberId || '';
    const vt = $('#waba-verify-token');
    if (vt && !data.hasAccessToken) vt.value = vt.value || '';
    const stats = $('#waba-stats');
    if (stats) {
      const parts = [];
      if (data.messagesReceived) parts.push(`${data.messagesReceived} webhook message(s) received`);
      if (data.lastWebhookAt) parts.push(`Last: ${formatBizTs(data.lastWebhookAt)}`);
      if (data.lastError) parts.push(`Error: ${data.lastError}`);
      stats.textContent = parts.join(' · ');
    }
  } catch { /* ignore */ }
}

export function initBusiness() {
  $('#smb-prompts')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-smb-query]');
    if (!btn) return;
    const q = btn.getAttribute('data-smb-query');
    if (!q) return;
    void openSearchAssistant({ showThreads: true, seedQuery: q, runSeed: true, startNew: true });
  });

  $('#business-inbox-panel')?.addEventListener('click', (e) => {
    const card = e.target.closest('[data-biz-jid]');
    if (!card) return;
    const jid = card.getAttribute('data-biz-jid');
    const mid = card.getAttribute('data-biz-mid');
    if (jid) void openChat(jid, mid || null);
  });

  $('#smb-expense-run-chat')?.addEventListener('change', () => {
    void loadExpenseSheetsForRunChat();
  });

  $('#smb-expense-run')?.addEventListener('click', async () => {
    const status = $('#smb-expense-run-status');
    const chatJid = $('#smb-expense-run-chat')?.value || '';
    const messageId = $('#smb-expense-run-sheet')?.value || '';
    if (!chatJid) {
      if (status) status.textContent = 'Select a group or imported chat first';
      return;
    }
    if (status) status.textContent = 'Queuing…';
    try {
      const r = await fetch('/api/expenses/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatJid, messageId: messageId || undefined }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Run failed');
      if (status) status.textContent = 'Queued — check reconciliation history for progress';
    } catch (err) {
      if (status) status.textContent = err.message || 'Run failed';
    }
  });

  $('#waba-save')?.addEventListener('click', async () => {
    const status = $('#waba-status');
    if (status) status.textContent = 'Saving…';
    try {
      const body = {
        phoneNumberId: $('#waba-phone-id')?.value || '',
        verifyToken: $('#waba-verify-token')?.value || '',
        accessToken: $('#waba-access-token')?.value || '',
        appSecret: $('#waba-app-secret')?.value || '',
      };
      const data = await fetch('/api/waba/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());
      if (data.error) throw new Error(data.error);
      if (status) status.textContent = data.configured ? 'Saved — add webhook URL in Meta' : 'Saved (fill all required fields)';
      $('#waba-access-token').value = '';
      $('#waba-app-secret').value = '';
      await loadWabaConfig();
    } catch (err) {
      if (status) status.textContent = err.message;
    }
  });

  $('#waba-test')?.addEventListener('click', async () => {
    const status = $('#waba-status');
    if (status) status.textContent = 'Testing…';
    try {
      const data = await fetch('/api/waba/test', { method: 'POST' }).then((r) => r.json());
      if (!data.ok) throw new Error(data.error || 'Test failed');
      if (status) status.textContent = `Connected: ${data.display}`;
    } catch (err) {
      if (status) status.textContent = err.message;
    }
  });

  $('#smb-save')?.addEventListener('click', async () => {
    const expenseSiteJids = selectedExpenseSiteJids();
    const status = $('#smb-status');
    if (status) status.textContent = 'Saving…';
    try {
      const data = await fetch('/api/smb/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: 'personal',
          expenseAgentEnabled: true,
          expenseSiteJids,
        }),
      }).then((r) => r.json());
      if (data.error) throw new Error(data.error);
      store.smbState = {
        profile: 'personal',
        businessName: '',
        prompts: [],
        expenseAgentEnabled: true,
        expenseSiteJids: Array.isArray(data.expenseSiteJids) ? data.expenseSiteJids : [],
      };
      syncSmbAgentCards();
      applySmbUi();
      if (status) status.textContent = 'Saved';
    } catch (err) {
      if (status) status.textContent = err.message;
    }
  });
}

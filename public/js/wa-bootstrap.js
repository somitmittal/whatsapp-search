import { store } from './store.js';
import { refreshDash } from './dashboard.js';
import { openOverlay } from './overlays.js';
import { renderChatsFromState } from './sidebar.js';
import { $ } from './util.js';
import { applyLiveSyncVisibility, enableLiveSyncUi, hasIndexedArchive, isWaUiReady, showQr, updateSidebarForWaState, updateWaUI, wantsLiveSyncUi } from './wa-connection.js';

// ── Sidebar sync chip ──────────────────────────────────────────────
// One compact badge for the whole background pipeline, in the order the server runs it.
const SYNC_CHIP_LABELS = {
  syncing: 'Syncing chats…',
  indexing: 'Indexing chats…',
  media: 'Indexing media…',
};

export function setSyncChipPhase(phase) {
  const el = $('#sync-chip');
  if (!el) return;
  const next = SYNC_CHIP_LABELS[phase] ? phase : null;
  if (next === store._syncChipPhase) return;
  store._syncChipPhase = next;
  el.classList.toggle('visible', Boolean(next));
  if (next) $('#sync-chip-text').textContent = SYNC_CHIP_LABELS[next];
}

export async function pollSyncChipPhase() {
  try {
    const r = await fetch('/api/indexing-phase');
    if (!r.ok) return;
    setSyncChipPhase((await r.json())?.phase);
  } catch { /* transient — the next tick retries */ }
}

// Fetch initial WA state on load
export async function bootstrapWhatsAppLinking(opts = {}) {
  const forceConnect = !!opts.forceConnect;
  try {
    const cfg = await fetch('/api/app-config').then((r) => r.json()).catch(() => ({}));
    window.__searchableAppConfig = cfg;
    store._importFirstMvp = cfg.importFirstMvp !== false;
    store._waLiveSyncAutoConnect = !!cfg.waLiveSyncAutoConnect;
    store.isDesktopApp = store.isDesktopApp || cfg.desktop === true;
    const dlLink = $('#welcome-desktop-dl');
    if (dlLink) dlLink.style.display = store.isDesktopApp ? 'none' : '';
    if (cfg.desktop || store._importFirstMvp) {
      store._showLiveSyncUi = localStorage.getItem('wa_show_live_sync') === '1';
    } else {
      store._showLiveSyncUi = localStorage.getItem('wa_show_live_sync') !== '0';
    }
    if (window.SearchableAccount) {
      try { await window.SearchableAccount.initAccountGate(cfg); } catch (_) { /* ignore */ }
    }

    await refreshDash();

    if (!store._importFirstMvp || store._waLiveSyncAutoConnect || store._showLiveSyncUi || forceConnect) {
      const st = await fetch('/api/wa/status').then((r) => r.json());
      updateWaUI(st);
      const shouldStartQr = (forceConnect || store._showLiveSyncUi || store._waLiveSyncAutoConnect)
        && st && (st.state === 'DISCONNECTED' || st.state === 'LOADING') && !st.hasQr;
      if (shouldStartQr) {
        try { await fetch('/api/wa/connect', { method: 'POST' }); } catch { /* ignore */ }
      }
      const d = await fetch('/api/wa/qr').then((r) => r.json());
      if (d && d.qr) showQr(d.qr);
    } else {
      store._waStateResolved = true;
      store._waState = 'DISCONNECTED';
      applyLiveSyncVisibility();
      $('#welcome-qr').style.display = 'none';
      $('#wqr-loading').style.display = 'none';
      $('#welcome-default').style.display = '';
      ensureImportFirstWelcome();
      updateSidebarForWaState();
      renderChatsFromState();
    }
  } catch { /* ignore */ }
}

export function ensureImportFirstWelcome() {
  if (!hasIndexedArchive()) return;
  if ($('#panel-empty')?.classList.contains('visible')) {
    const showQrWelcome = wantsLiveSyncUi() && !isWaUiReady();
    $('#welcome-qr').style.display = showQrWelcome ? '' : 'none';
    $('#sync-progress-panel').style.display = 'none';
    $('#wqr-loading').style.display = 'none';
    $('#welcome-default').style.display = showQrWelcome ? 'none' : '';
  }
}

export async function refreshContactNames(opts = {}) {
  const btn = document.getElementById('wa-refresh-names');
  const status = document.getElementById('wa-refresh-names-status');
  if (btn) btn.disabled = true;
  if (status) status.textContent = 'Refreshing…';
  try {
    const r = await fetch('/api/wa/sync-contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto: !!opts.auto }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error || 'Failed');
    if (status) status.textContent = `Updated ${j.rowsUpdated || 0} message rows`;
    setTimeout(() => { if (status) status.textContent = ''; }, 4000);
  } catch (e) {
    if (status) status.textContent = e.message || 'Failed';
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function initWaBootstrap() {
  // Same cadence as the WhatsApp status poll; the endpoint only reads in-memory flags.
  setInterval(pollSyncChipPhase, 3000);
  void pollSyncChipPhase();
  void bootstrapWhatsAppLinking();

  // Logout button
  $('#wa-logout-btn').addEventListener('click', async () => {
    if (!confirm('Log out of WhatsApp? You will need to scan a new QR code to reconnect.')) return;
    await fetch('/api/wa/logout', { method: 'POST' });
    updateWaUI({ state: 'DISCONNECTED', message: 'Logged out' });
  });

  document.getElementById('sidebar-import-btn')?.addEventListener('click', () => openOverlay('import'));

  document.getElementById('btn-enable-live-sync')?.addEventListener('click', () => {
    if (confirm('Enable live WhatsApp QR sync? Your phone will link as a companion device. You can keep using imports anytime.')) {
      enableLiveSyncUi();
      openOverlay('settings');
    }
  });

  document.getElementById('wa-refresh-names')?.addEventListener('click', () => refreshContactNames());
}

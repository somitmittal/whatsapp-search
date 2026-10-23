import { store } from './store.js';
import { hideAwaySummaryBar } from './away-summary.js';
import { updateComposerVisibility } from './composer.js';
import { refreshDash } from './dashboard.js';
import { liveSyncPillStatus } from './live-sync-status.js';
import { switchPanel } from './overlays.js';
import { autoSelectSidebarTab, renderChatsFromState } from './sidebar.js';
import { $ } from './util.js';
import { bootstrapWhatsAppLinking, refreshContactNames, setSyncChipPhase } from './wa-bootstrap.js';

export function hasIndexedArchive() {
  return (Array.isArray(store.chatData) && store.chatData.length > 0)
    || store._archiveChatCount > 0
    || store._archiveMessageCount > 0;
}

export function canShowChatUI() {
  return isWaUiReady() || hasIndexedArchive();
}

export function wantsLiveSyncUi() {
  return !store._importFirstMvp || store._showLiveSyncUi || isWaUiReady();
}

export function applyLiveSyncVisibility() {
  const show = wantsLiveSyncUi();
  document.querySelectorAll(".live-sync-ui").forEach((el) => {
    // The pairing panel is shown only while a scan is actually needed.
    // Blanket-showing every live-sync node was putting an empty QR box
    // back on screen after a successful link.
    if (el.id === "welcome-qr") return;
    el.style.display = show ? "" : "none";
  });
  const wqr = document.getElementById("welcome-qr");
  if (wqr && (isWaUiReady() || !show)) wqr.style.display = "none";
  const wdef = document.getElementById("welcome-default");
  if (wdef && store._importFirstMvp && !isWaUiReady() && hasIndexedArchive()) wdef.style.display = "";
  const waSettings = document.getElementById("wa-live-sync-settings");
  if (waSettings) waSettings.style.display = store._showLiveSyncUi ? "" : "none";
  const btnWa = document.getElementById("btn-link-whatsapp");
  if (btnWa) btnWa.style.display = show ? "" : "none";
  const banner = document.getElementById("wa-banner");
  if (banner && store._importFirstMvp && !show) banner.style.display = "none";
  renderLiveSyncAdvanced();
}

/**
 * Advanced settings card: swap the "enable" call to action for a status pill once the user
 * has opted in, so a linked account doesn't keep offering to link.
 */
function renderLiveSyncAdvanced() {
  const pill = document.getElementById("live-sync-pill");
  const pillText = document.getElementById("live-sync-pill-text");
  const blurb = document.getElementById("live-sync-blurb");
  const btn = document.getElementById("btn-enable-live-sync");
  if (!pill || !pillText || !btn) return;
  const optedIn = store._showLiveSyncUi || isWaUiReady();
  pill.hidden = !optedIn;
  btn.style.display = optedIn ? "none" : "";
  // Leave the opt-in blurb as authored — it carries markup the JS strings don't.
  if (!optedIn) return;
  const status = liveSyncPillStatus({
    waState: store._waState,
    needsRelogin: store._waNeedsRelogin,
    loggedOut: store._waLoggedOut,
  });
  pill.classList.toggle("pending", !status.connected);
  pillText.textContent = status.text;
  if (blurb) blurb.textContent = status.blurb;
}

export function enableLiveSyncUi() {
  store._showLiveSyncUi = true;
  localStorage.setItem("wa_show_live_sync", "1");
  applyLiveSyncVisibility();
  updateSidebarForWaState();
  renderChatsFromState();
  void bootstrapWhatsAppLinking({ forceConnect: true });
}

export function isWaUiReady() {
  return store._waStateResolved && (
    store._waState === 'READY'
    || store._waState === 'SYNCING'
    || (store._waHasEverConnected && !store._waNeedsRelogin)
  );
}

function applyPendingWaBootstrapUi() {
  if (!wantsLiveSyncUi() || hasIndexedArchive()) return;
  const loggedOutEl = $('#sidebar-logged-out');
  const chatListEl = $('#chat-list');
  const syncBarEl = $('#sidebar-sync-bar');
  const filterEl = document.querySelector('.sidebar-search');
  const tabsEl = document.querySelector('.sidebar-chat-tabs');
  const stripEl = $('#status-strip-wrap');
  if (loggedOutEl) loggedOutEl.style.display = 'none';
  if (chatListEl) chatListEl.style.display = 'none';
  if (syncBarEl) syncBarEl.style.display = 'none';
  if (filterEl) filterEl.style.display = 'none';
  if (tabsEl) tabsEl.style.display = 'none';
  if (stripEl) stripEl.hidden = true;
  if ($('#panel-empty')?.classList.contains('visible')) {
    $('#welcome-qr').style.display = '';
    $('#welcome-default').style.display = 'none';
    $('#sync-progress-panel').style.display = 'none';
    $('#wqr-loading').style.display = 'flex';
    $('#wqr-loading-text').textContent = 'Checking WhatsApp session…';
  }
}

// WhatsApp gives each subsequent QR a 20s life. If nothing new has arrived in that long,
// the socket has stopped producing codes and will not recover on its own.
const QR_STALL_MS = 20000;

async function pollForQrWhileDisconnected() {
  if (store._qrPollTimer || store._waState === 'READY' || store._waState === 'SYNCING') return;
  store._qrPollTimer = setInterval(async () => {
    if (store._waState === 'READY' || store._waState === 'SYNCING') {
      clearInterval(store._qrPollTimer);
      store._qrPollTimer = null;
      return;
    }
    try {
      const [st, qr] = await Promise.all([
        fetch('/api/wa/status').then(r => r.json()).catch(() => null),
        fetch('/api/wa/qr').then(r => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (st) updateWaUI(st);
      if (qr?.qr) showQr(qr.qr);
      else await recoverStalledQr(st);
    } catch { /* ignore */ }
  }, 3000);
}

/**
 * The server has no QR to give. Flag that a new one is coming, and once the socket has
 * been quiet for longer than a QR is meant to live, ask it to reconnect — without this
 * the panel stays blank until the user reloads the page.
 */
async function recoverStalledQr(st) {
  if (!wantsLiveSyncUi()) return;
  markQrRefreshing();
  const now = Date.now();
  if (now - store._lastQrSeenAt < QR_STALL_MS || now - store._lastQrNudgeAt < QR_STALL_MS) return;
  const state = st?.state || store._waState;
  if (state === 'READY' || state === 'SYNCING') return;
  store._lastQrNudgeAt = now;
  try { await fetch('/api/wa/connect', { method: 'POST' }); } catch { /* ignore */ }
}

function markQrRefreshing() {
  // Drop the cached data URL so the next QR always repaints, even if it repeats.
  store._lastQrDataUrl = null;
  const overlay = $('#wqr-refreshing');
  if (overlay && $('#wqr-img')?.getAttribute('src')) overlay.style.display = 'flex';
  const line = $('#wqr-status-line');
  if (line) line.textContent = 'Fetching a fresh QR code…';
}

// deferred: bootstrapWhatsAppLinking

export function updateSidebarForWaState() {
  const loggedOutEl = $('#sidebar-logged-out');
  const chatListEl = $('#chat-list');
  const syncBarEl = $('#sidebar-sync-bar');
  const filterEl = document.querySelector('.sidebar-search');
  const tabsEl = document.querySelector('.sidebar-chat-tabs');
  const stripEl = $('#status-strip-wrap');

  // Hide WA-synced chats when WA is not connected (QR showing / logged out).
  // Always show the sidebar if imported chats exist.
  const waNotConnected = store._waStateResolved
    && (store._waState === 'QR_READY' || store._waState === 'DISCONNECTED' || store._waState === 'LOADING')
    && !isWaUiReady();
  const hasImportedChats = (Array.isArray(store.chatData) && store.chatData.some((c) => c.chatJid && c.chatJid.endsWith('@imported')))
    || store._justImportedJid;
  const showChats = canShowChatUI() && (!waNotConnected || hasImportedChats);

  if (!loggedOutEl && !chatListEl) return;

  if (!showChats) {
    if (loggedOutEl) loggedOutEl.style.display = '';
    if (chatListEl) chatListEl.style.display = 'none';
    const impPrompt = document.getElementById('sidebar-import-prompt');
    const waPrompt = document.getElementById('sidebar-wa-prompt');
    const emptyIcon = document.getElementById('sidebar-empty-icon');
    if (impPrompt && waPrompt && store._importFirstMvp && !wantsLiveSyncUi()) {
      impPrompt.style.display = '';
      waPrompt.style.display = 'none';
      if (emptyIcon) emptyIcon.style.display = 'none';
    } else if (impPrompt && waPrompt) {
      impPrompt.style.display = 'none';
      waPrompt.style.display = '';
      if (emptyIcon) emptyIcon.style.display = '';
    }
    if (syncBarEl) syncBarEl.style.display = 'none';
    if (filterEl) filterEl.style.display = 'none';
    if (tabsEl) tabsEl.style.display = 'none';
    if (stripEl) stripEl.hidden = true;
    const btn = $('#sidebar-link-wa-btn');
    if (btn) {
      btn.textContent = store._waLoggedOut ? 'Scan QR Code' : 'Reconnect WhatsApp';
    }
  } else {
    if (loggedOutEl) loggedOutEl.style.display = 'none';
    if (chatListEl) chatListEl.style.display = '';
    if (filterEl) filterEl.style.display = '';
    if (tabsEl) tabsEl.style.display = '';

    if (syncBarEl) {
      syncBarEl.style.display = (store._waState === 'SYNCING' || store._historySyncActive) ? '' : 'none';
    }
  }
}

/**
 * Once the first history messages are in the DB, show the normal empty welcome (chat list in sidebar is useful)
 * instead of the full-screen “syncing” panel — history may still load in the background until READY.
 */
export function adjustSyncingMainPanel() {
  if (store._waState !== 'SYNCING') return;
  if (!$('#panel-empty')?.classList.contains('visible')) return;
  const hasChats = store.chatData && store.chatData.length > 0;
  if (!hasChats) return;
  if ($('#welcome-qr')) $('#welcome-qr').style.display = 'none';
  if ($('#welcome-default')) $('#welcome-default').style.display = '';
  if ($('#sync-progress-panel')) $('#sync-progress-panel').style.display = 'none';
  if ($('#wqr-loading')) $('#wqr-loading').style.display = 'none';
}

export function updateWaUI({ state, message, sync }) {
  store._waStateResolved = true;
  store._waState = state;
  // History can keep streaming after the UI is promoted to READY — server tells us.
  store._historySyncActive = Boolean(sync?.syncing) || (state === 'SYNCING');
  const msg = message || '';

  if (state === 'READY' || state === 'SYNCING') {
    store._waHasEverConnected = true;
    store._waLoggedOut = false;
    store._waNeedsRelogin = false;
  } else if (state === 'DISCONNECTED' && /logged out|rescan qr/i.test(msg)) {
    store._waLoggedOut = true;
    store._waNeedsRelogin = true;
  } else if (state === 'QR_READY' && wantsLiveSyncUi()) {
    store._waLoggedOut = true;
    store._waNeedsRelogin = true;
  }

  const dot = $('#wa-dot');
  const txt = $('#wa-status-text');
  const banner = $('#wa-banner');
  const logoutBtn = $('#wa-logout-btn');
  const hasChats = store.chatData && store.chatData.length > 0;
  const setDisp = (el, v) => { if (el) el.style.display = v; };

  if (txt) txt.textContent = message || state;
  if (dot) dot.className = 'health-dot ' + (state === 'READY' ? 'ok' : state === 'QR_READY' ? 'warn' : 'unknown');
  setDisp(logoutBtn, state === 'READY' ? '' : 'none');

  // Settings panel sub-sections
  const qrPanel = $('#wa-qr-panel');
  const readyPanel = $('#wa-ready-panel');
  if (qrPanel) {
    qrPanel.style.display = state === 'QR_READY' ? '' : 'none';
    if (state === 'QR_READY' && store._lastQrDataUrl) applyQrImages(store._lastQrDataUrl);
  }
  if (readyPanel) readyPanel.style.display = state === 'READY' ? '' : 'none';
  if (state === 'READY' && $('#wa-ready-msg')) $('#wa-ready-msg').textContent = message || 'Connected';

  // Sidebar banner (hidden when logged-out overlay is shown or import-first without live sync)
  if (banner) {
    if (state === 'READY' || store._waLoggedOut || !wantsLiveSyncUi()) {
      banner.style.display = 'none';
    } else if (state === 'QR_READY') {
      banner.style.display = 'flex';
      banner.style.background = '#fff3cd'; banner.style.color = '#856404';
      if ($('#wa-banner-text')) $('#wa-banner-text').textContent = 'Scan QR code to connect WhatsApp';
    } else if (wantsLiveSyncUi()) {
      banner.style.display = 'flex';
      banner.style.background = '#f0f2f5'; banner.style.color = '#667781';
      if ($('#wa-banner-text')) $('#wa-banner-text').textContent = message || 'Connecting…';
    } else {
      banner.style.display = 'none';
    }
  }

  updateSidebarForWaState();
  // Linking WhatsApp is a deliberate act, so let it win over an earlier tab choice — once.
  if (isWaUiReady() && !store._waTabPromotedOnConnect) {
    store._waTabPromotedOnConnect = true;
    store.sidebarTabPinnedByUser = false;
  }
  // The tab pick depends on _waState, which only settled on the line above — re-run it here
  // or a freshly linked account keeps showing the imported list with its live chats hidden.
  applyLiveSyncVisibility();
  autoSelectSidebarTab();
  renderChatsFromState();

  // Main panel: show correct screen based on state (classic UI only)
  const isEmptyPanel = !!$('#panel-empty')?.classList.contains('visible');
  if (state === 'READY') {
    clearInterval(store._qrPollTimer);
    store._qrPollTimer = null;
    setDisp($('#welcome-qr'), 'none');
    setDisp($('#sync-progress-panel'), 'none');
    setDisp($('#welcome-default'), '');
    setDisp($('#wqr-loading'), 'none');
    store.waSyncByChat = {};
    applyWaSyncBars();
    refreshDash();
    // Auto-refresh names once per page load after connect (best effort).
    if (!window.__waNamesRefreshedOnce) {
      window.__waNamesRefreshedOnce = true;
      setTimeout(() => { refreshContactNames({ auto: true }); }, 1500);
    }
  } else if (state === 'SYNCING') {
    setDisp($('#welcome-qr'), 'none');
    setDisp($('#wqr-loading'), 'none');
    if (isEmptyPanel && hasChats) {
      setDisp($('#welcome-default'), '');
      setDisp($('#sync-progress-panel'), 'none');
    } else if (isEmptyPanel && !hasChats) {
      setDisp($('#welcome-default'), 'none');
      setDisp($('#sync-progress-panel'), '');
    } else {
      setDisp($('#welcome-default'), 'none');
      setDisp($('#sync-progress-panel'), 'none');
    }
  } else if (state === 'QR_READY' || store._waNeedsRelogin || store._waLoggedOut) {
    // Never tear away a chat the user is actively viewing just to show the QR.
    if (wantsLiveSyncUi()) {
      pollForQrWhileDisconnected();
      setDisp($('#sync-progress-panel'), 'none');
      if (isEmptyPanel) {
        setDisp($('#welcome-qr'), '');
        setDisp($('#welcome-default'), 'none');
      }
      if (store._lastQrDataUrl) {
        applyQrImages(store._lastQrDataUrl);
        setDisp($('#wqr-loading'), 'none');
      } else {
        setDisp($('#wqr-loading'), 'flex');
        if ($('#wqr-loading-text')) $('#wqr-loading-text').textContent = 'Fetching QR code…';
      }
    } else if (store.activeChat) {
      switchPanel();
    }
  } else {
    // LOADING or DISCONNECTED without an explicit relogin requirement.
    if (wantsLiveSyncUi()) pollForQrWhileDisconnected();
    setDisp($('#sync-progress-panel'), 'none');
    if (state === 'DISCONNECTED' || state === 'LOADING') {
      store.waSyncByChat = {};
      applyWaSyncBars();
    }
    if (wantsLiveSyncUi() && isEmptyPanel && !hasChats && !store._waHasEverConnected) {
      setDisp($('#welcome-qr'), '');
      setDisp($('#welcome-default'), 'none');
    }
    if (wantsLiveSyncUi() && isEmptyPanel && !store._waHasEverConnected) {
      setDisp($('#wqr-loading'), 'flex');
      if ($('#wqr-loading-text')) $('#wqr-loading-text').textContent = message || 'Starting WhatsApp…';
    } else {
      setDisp($('#wqr-loading'), 'none');
    }
  }
  applyLiveSyncVisibility();
  updateComposerVisibility();
  if (state !== 'READY' && state !== 'SYNCING') {
    store.awaySummarySnapshot = null;
    hideAwaySummaryBar();
  }
  if (store.activeChat && hasIndexedArchive()) switchPanel();
}

function applyQrImages(dataUrl) {
  if (!dataUrl) return;
  const welcome = $('#wqr-img');
  const settings = $('#wa-qr-img');
  if (welcome) welcome.src = dataUrl;
  if (settings) settings.src = dataUrl;
}

export function showQr(dataUrl) {
  if (!dataUrl) return;
  if (store._importFirstMvp && !store._showLiveSyncUi) return;
  // Already linked (or mid-history-sync): never force the QR panel back over chats.
  // Late/stale wa-qr events were why a broken QR showed while "Syncing chats…" ran.
  if (store._waState === 'READY' || store._waState === 'SYNCING' || isWaUiReady()) {
    if ($('#welcome-qr')) $('#welcome-qr').style.display = 'none';
    if ($('#wqr-loading')) $('#wqr-loading').style.display = 'none';
    return;
  }
  const isRepeat = dataUrl === store._lastQrDataUrl;
  store._lastQrDataUrl = dataUrl;
  store._lastQrSeenAt = Date.now();
  applyQrImages(dataUrl);

  if ($('#wqr-loading')) $('#wqr-loading').style.display = 'none';
  if ($('#wqr-refreshing')) $('#wqr-refreshing').style.display = 'none';
  pollForQrWhileDisconnected();
  if (isRepeat) return;
  if (store.activeChat && hasIndexedArchive()) {
    switchPanel();
    return;
  }
  if ($('#welcome-qr')) $('#welcome-qr').style.display = '';
  if ($('#welcome-default')) $('#welcome-default').style.display = 'none';
  if ($('#sync-progress-panel')) $('#sync-progress-panel').style.display = 'none';
  if ($('#wqr-status-line')) $('#wqr-status-line').textContent = 'Scan with your phone — refreshes automatically';
}

export function updateSyncProgress(data) {
  const { completed, total, messages, byChat, progress } = data || {};
  const done = Boolean(data?.done);
  // True while history is downloading, even after the UI state flips to READY.
  store._historySyncActive = !done;
  if (done) {
    // "Chats are syncing" must end with a clear completion moment, not just fade away.
    setSyncChipPhase('synced');
    const bar = $('#sync-bar');
    if (bar) { bar.style.width = '100%'; bar.style.animation = ''; }
    const pctEl = $('#sync-pct');
    if (pctEl) pctEl.textContent = '100%';
    const detail = $('#sync-detail');
    if (detail) detail.textContent = 'Sync complete';
    const sidebarFill = $('#sidebar-sync-fill');
    if (sidebarFill) { sidebarFill.style.width = '100%'; sidebarFill.style.animation = ''; }
    const sidebarText = $('#sidebar-sync-text');
    if (sidebarText) sidebarText.textContent = 'Sync complete ✓';
    clearTimeout(store._syncDoneTimer);
    store._syncDoneTimer = setTimeout(() => {
      store._historySyncActive = false;
      store.waSyncByChat = {};
      updateSidebarForWaState();
      // Don't clear a later pipeline phase (e.g. "Indexing chats…") that already took over.
      if (store._syncChipPhase === 'synced') setSyncChipPhase(null);
      if ($('#sync-progress-panel')) $('#sync-progress-panel').style.display = 'none';
    }, 5000);
    return;
  }
  setSyncChipPhase('syncing');
  if (byChat && typeof byChat === 'object') {
    store.waSyncByChat = { ...byChat };
    applyWaSyncBars();
  }
  // Prefer WhatsApp's own transfer progress; otherwise Baileys sends total=0 (unknown) — indeterminate bar.
  const hasProgress = Number.isFinite(progress);
  const hasTotal = hasProgress || total > 0;
  const pct = hasProgress ? Math.round(progress) : hasTotal ? Math.round((completed / total) * 100) : 0;
  $('#sync-bar').style.width = hasTotal ? pct + '%' : '100%';
  $('#sync-bar').style.animation = hasTotal ? '' : 'sync-pulse 1.5s ease-in-out infinite';
  $('#sync-pct').textContent = hasTotal ? pct + '%' : 'syncing…';
  const msgN = messages ?? 0;
  $('#sync-msgs').textContent = msgN.toLocaleString() + ' messages';
  $('#sync-detail').textContent = total > 0 ? `${completed} of ${total} chats` : 'Receiving history…';

  // Sidebar sync bar
  const sidebarFill = $('#sidebar-sync-fill');
  const sidebarText = $('#sidebar-sync-text');
  // Keep the bar visible even after the UI state became READY mid-sync
  // (updateSidebarForWaState hides it for READY; undo that while sync is active).
  const sidebarBar = $('#sidebar-sync-bar');
  if (sidebarBar) sidebarBar.style.display = '';
  if (sidebarFill) {
    sidebarFill.style.width = hasTotal ? pct + '%' : '40%';
    sidebarFill.style.animation = hasTotal ? '' : 'sync-pulse 1.5s ease-in-out infinite';
  }
  if (sidebarText) {
    sidebarText.textContent = hasTotal
      ? `Syncing chats… ${pct}% (${msgN.toLocaleString()} messages)`
      : `Syncing chats… ${msgN.toLocaleString()} messages`;
  }

  const emptyMain = $('#panel-empty').classList.contains('visible');
  const hasChats = store.chatData && store.chatData.length > 0;
  const hasIndexed = hasChats || (typeof messages === 'number' && messages > 0);
  if (store._waState === 'SYNCING' && emptyMain && hasIndexed) {
    $('#welcome-default').style.display = '';
    $('#sync-progress-panel').style.display = 'none';
  } else if (store._waState === 'SYNCING' && emptyMain && !hasIndexed) {
    $('#sync-progress-panel').style.display = '';
    $('#welcome-qr').style.display = 'none';
    $('#welcome-default').style.display = 'none';
  }
}

export function applyWaSyncBars() {
  // Per-chat sync bars removed; sync progress is shown via the single sidebar-level bar.
}

export function initWaConnection() {
  store.isDesktopApp = window.desktopApp?.isDesktop === true
    || new URLSearchParams(window.location.search).get('desktop') === '1';
}

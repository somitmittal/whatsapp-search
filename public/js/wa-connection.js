import { store } from './store.js';
import { hideAwaySummaryBar } from './away-summary.js';
import { updateComposerVisibility } from './composer.js';
import { refreshDash } from './dashboard.js';
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
  const connected = isWaUiReady();
  pill.classList.toggle("pending", !connected);
  pillText.textContent = connected
    ? (store._waState === "SYNCING" ? "QR sync enabled \u00b7 syncing chats\u2026" : "QR sync enabled \u00b7 WhatsApp connected")
    : "QR sync enabled \u00b7 waiting for QR scan";
  if (blurb) {
    blurb.textContent = connected
      ? "Your phone is linked as a companion device. Live chats appear in the WhatsApp tab."
      : "Scan the QR code in the WhatsApp Connection section above to finish linking.";
  }
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

  if (!showChats) {
    loggedOutEl.style.display = '';
    chatListEl.style.display = 'none';
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
    syncBarEl.style.display = 'none';
    if (filterEl) filterEl.style.display = 'none';
    if (tabsEl) tabsEl.style.display = 'none';
    if (stripEl) stripEl.hidden = true;
    const btn = $('#sidebar-link-wa-btn');
    if (btn) {
      btn.textContent = store._waLoggedOut ? 'Scan QR Code' : 'Reconnect WhatsApp';
    }
  } else {
    loggedOutEl.style.display = 'none';
    chatListEl.style.display = '';
    if (filterEl) filterEl.style.display = '';
    if (tabsEl) tabsEl.style.display = '';

    if (store._waState === 'SYNCING') {
      syncBarEl.style.display = '';
    } else {
      syncBarEl.style.display = 'none';
    }
  }
}

/**
 * Once the first history messages are in the DB, show the normal empty welcome (chat list in sidebar is useful)
 * instead of the full-screen “syncing” panel — history may still load in the background until READY.
 */
export function adjustSyncingMainPanel() {
  if (store._waState !== 'SYNCING') return;
  const emptyMain = $('#panel-empty').classList.contains('visible');
  if (!emptyMain) return;
  const hasChats = store.chatData && store.chatData.length > 0;
  if (!hasChats) return;
  $('#welcome-qr').style.display = 'none';
  $('#welcome-default').style.display = '';
  $('#sync-progress-panel').style.display = 'none';
  $('#wqr-loading').style.display = 'none';
}

export function updateWaUI({ state, message }) {
  store._waStateResolved = true;
  store._waState = state;
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

  txt.textContent = message || state;
  dot.className = 'health-dot ' + (state === 'READY' ? 'ok' : state === 'QR_READY' ? 'warn' : 'unknown');
  logoutBtn.style.display = state === 'READY' ? '' : 'none';

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
  if (state === 'READY' || store._waLoggedOut || !wantsLiveSyncUi()) {
    banner.style.display = 'none';
  } else if (state === 'QR_READY') {
    banner.style.display = 'flex';
    banner.style.background = '#fff3cd'; banner.style.color = '#856404';
    $('#wa-banner-text').textContent = 'Scan QR code to connect WhatsApp';
  } else if (wantsLiveSyncUi()) {
    banner.style.display = 'flex';
    banner.style.background = '#f0f2f5'; banner.style.color = '#667781';
    $('#wa-banner-text').textContent = message || 'Connecting…';
  } else {
    banner.style.display = 'none';
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

  // Main panel: show correct screen based on state
  const isEmptyPanel = $('#panel-empty').classList.contains('visible');
  if (state === 'READY') {
    clearInterval(store._qrPollTimer);
    store._qrPollTimer = null;
    $('#welcome-qr').style.display = 'none';
    $('#sync-progress-panel').style.display = 'none';
    $('#welcome-default').style.display = '';
    $('#wqr-loading').style.display = 'none';
    store.waSyncByChat = {};
    applyWaSyncBars();
    refreshDash();
    // Auto-refresh names once per page load after connect (best effort).
    if (!window.__waNamesRefreshedOnce) {
      window.__waNamesRefreshedOnce = true;
      setTimeout(() => { refreshContactNames({ auto: true }); }, 1500);
    }
  } else if (state === 'SYNCING') {
    $('#welcome-qr').style.display = 'none';
    $('#wqr-loading').style.display = 'none';
    if (isEmptyPanel && hasChats) {
      $('#welcome-default').style.display = '';
      $('#sync-progress-panel').style.display = 'none';
    } else if (isEmptyPanel && !hasChats) {
      $('#welcome-default').style.display = 'none';
      $('#sync-progress-panel').style.display = '';
    } else {
      $('#welcome-default').style.display = 'none';
      $('#sync-progress-panel').style.display = 'none';
    }
  } else if (state === 'QR_READY' || store._waNeedsRelogin || store._waLoggedOut) {
    // Never tear away a chat the user is actively viewing just to show the QR.
    if (wantsLiveSyncUi()) {
      pollForQrWhileDisconnected();
      $('#sync-progress-panel').style.display = 'none';
      if (isEmptyPanel) {
        $('#welcome-qr').style.display = '';
        $('#welcome-default').style.display = 'none';
      }
      if (store._lastQrDataUrl) {
        applyQrImages(store._lastQrDataUrl);
        $('#wqr-loading').style.display = 'none';
      } else {
        $('#wqr-loading').style.display = 'flex';
        if ($('#wqr-loading-text')) $('#wqr-loading-text').textContent = 'Fetching QR code…';
      }
    } else if (store.activeChat) {
      switchPanel();
    }
  } else {
    // LOADING or DISCONNECTED without an explicit relogin requirement.
    if (wantsLiveSyncUi()) pollForQrWhileDisconnected();
    $('#sync-progress-panel').style.display = 'none';
    if (state === 'DISCONNECTED' || state === 'LOADING') {
      store.waSyncByChat = {};
      applyWaSyncBars();
    }
    if (wantsLiveSyncUi() && isEmptyPanel && !hasChats && !store._waHasEverConnected) {
      $('#welcome-qr').style.display = '';
      $('#welcome-default').style.display = 'none';
    }
    if (wantsLiveSyncUi() && isEmptyPanel && !store._waHasEverConnected) {
      $('#wqr-loading').style.display = 'flex';
      $('#wqr-loading-text').textContent = message || 'Starting WhatsApp…';
    } else {
      $('#wqr-loading').style.display = 'none';
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
    $('#welcome-qr').style.display = 'none';
    $('#wqr-loading').style.display = 'none';
    return;
  }
  const isRepeat = dataUrl === store._lastQrDataUrl;
  store._lastQrDataUrl = dataUrl;
  store._lastQrSeenAt = Date.now();
  applyQrImages(dataUrl);

  $('#wqr-loading').style.display = 'none';
  $('#wqr-refreshing').style.display = 'none';
  pollForQrWhileDisconnected();
  if (isRepeat) return;
  if (store.activeChat && hasIndexedArchive()) {
    switchPanel();
    return;
  }
  $('#welcome-qr').style.display = '';
  $('#welcome-default').style.display = 'none';
  $('#sync-progress-panel').style.display = 'none';
  $('#wqr-status-line').textContent = 'Scan with your phone — refreshes automatically';
}

export function updateSyncProgress(data) {
  setSyncChipPhase('syncing');
  const { completed, total, messages, byChat } = data || {};
  if (byChat && typeof byChat === 'object') {
    store.waSyncByChat = { ...byChat };
    applyWaSyncBars();
  }
  // Baileys sends total=0 (unknown) — show an animated indeterminate bar
  const hasTotal = total > 0;
  const pct = hasTotal ? Math.round((completed / total) * 100) : 0;
  $('#sync-bar').style.width = hasTotal ? pct + '%' : '100%';
  $('#sync-bar').style.animation = hasTotal ? '' : 'sync-pulse 1.5s ease-in-out infinite';
  $('#sync-pct').textContent = hasTotal ? pct + '%' : 'syncing…';
  const msgN = messages ?? 0;
  $('#sync-msgs').textContent = msgN.toLocaleString() + ' messages';
  $('#sync-detail').textContent = hasTotal ? `${completed} of ${total} chats` : 'Receiving history…';

  // Sidebar sync bar
  const sidebarFill = $('#sidebar-sync-fill');
  const sidebarText = $('#sidebar-sync-text');
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

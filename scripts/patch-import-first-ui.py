#!/usr/bin/env python3
"""Patch import-first MVP UI (keeps WA sync code, hides until opted in)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
p = ROOT / "public/index.html"
t = p.read_text()

if "_importFirstMvp" not in t:
    marker = "  let _lastQrDataUrl = null;\n"
    inject = """  let _lastQrDataUrl = null;
  let _importFirstMvp = true;
  let _waLiveSyncAutoConnect = false;
  let _showLiveSyncUi = localStorage.getItem("wa_show_live_sync") === "1";
  let _archiveChatCount = 0;
  let _archiveMessageCount = 0;

  function hasIndexedArchive() {
    return (Array.isArray(chatData) && chatData.length > 0)
      || _archiveChatCount > 0
      || _archiveMessageCount > 0;
  }

  function canShowChatUI() {
    return isWaUiReady() || hasIndexedArchive();
  }

  function wantsLiveSyncUi() {
    return !_importFirstMvp || _showLiveSyncUi || isWaUiReady();
  }

  function applyLiveSyncVisibility() {
    const show = wantsLiveSyncUi();
    document.querySelectorAll(".live-sync-ui").forEach((el) => {
      el.style.display = show ? "" : "none";
    });
    const wqr = document.getElementById("welcome-qr");
    if (wqr && _importFirstMvp && !show && !isWaUiReady()) wqr.style.display = "none";
    const wdef = document.getElementById("welcome-default");
    if (wdef && _importFirstMvp && !isWaUiReady() && hasIndexedArchive()) wdef.style.display = "";
    const waSettings = document.getElementById("wa-live-sync-settings");
    if (waSettings) waSettings.style.display = _showLiveSyncUi ? "" : "none";
    const btnWa = document.getElementById("btn-link-whatsapp");
    if (btnWa) btnWa.style.display = show ? "" : "none";
    const banner = document.getElementById("wa-banner");
    if (banner && _importFirstMvp && !show) banner.style.display = "none";
  }

  function enableLiveSyncUi() {
    _showLiveSyncUi = true;
    localStorage.setItem("wa_show_live_sync", "1");
    applyLiveSyncVisibility();
    updateSidebarForWaState();
    renderChatsFromState();
    void bootstrapWhatsAppLinking({ forceConnect: true });
  }

"""
    t = t.replace(marker, inject, 1)

if "sidebar-import-prompt" not in t:
    t = t.replace(
        '      <motion.div style="font-weight:600;font-size:15px;color:var(--text);margin-bottom:6px;">Link WhatsApp</motion.div>',
        '      <motion.div style="font-weight:600;font-size:15px;color:var(--text);margin-bottom:6px;">Link WhatsApp</motion.div>',
    )
    t = t.replace(
        '      <div style="font-weight:600;font-size:15px;color:var(--text);margin-bottom:6px;">Link WhatsApp</div>',
        """      <div id="sidebar-import-prompt" style="display:none;">
        <div style="font-weight:600;font-size:15px;color:var(--text);margin-bottom:6px;">Import your chats</div>
        <div style="font-size:13px;color:var(--text2);line-height:1.4;margin-bottom:18px;">
          Export a chat on your phone (.zip) and upload with <strong>+</strong> above.
        </div>
        <button type="button" id="sidebar-import-btn" class="btn btn-primary" style="padding:8px 24px;font-size:13px;border-radius:20px;background:#00a884;border:none;color:#fff;cursor:pointer;margin-bottom:14px;">
          Import chat export
        </button>
      </div>
      <motion.div id="sidebar-wa-prompt" class="live-sync-ui">
      <div style="font-weight:600;font-size:15px;color:var(--text);margin-bottom:6px;">Link WhatsApp</div>""".replace(
            "<motion.div id", "<motion.div id"
        ),
        1,
    )
    t = t.replace(
        'id="sidebar-wa-prompt" class="live-sync-ui">\n      <div',
        'id="sidebar-wa-prompt" class="live-sync-ui">\n        <div',
        1,
    )
    t = t.replace(
        """      <button type="button" id="sidebar-link-wa-btn" class="btn btn-primary" style="padding:8px 24px;font-size:13px;border-radius:20px;background:#00a884;border:none;color:#fff;cursor:pointer;">
        Scan QR Code
      </button>
    </div>""",
        """        <button type="button" id="sidebar-link-wa-btn" class="btn btn-primary" style="padding:8px 24px;font-size:13px;border-radius:20px;background:#00a884;border:none;color:#fff;cursor:pointer;">
          Scan QR Code
        </button>
      </div>
    </div>""",
        1,
    )
    t = t.replace("<motion.div id=\"sidebar-wa-prompt\"", "<div id=\"sidebar-wa-prompt\"")

if 'id="welcome-qr" class="welcome-panel live-sync-ui"' not in t:
    t = t.replace(
        'id="welcome-qr" class="welcome-panel"',
        'id="welcome-qr" class="welcome-panel live-sync-ui"',
        1,
    )

if 'id="btn-enable-live-sync"' not in t:
    t = t.replace(
        '        <div class="setting-group">\n          <h3>Data</h3>',
        """        <div class="setting-group">
          <h3>Advanced</h3>
          <p style="font-size:13px;color:var(--text2);">Live WhatsApp QR sync is optional. Import exports with <strong>+</strong> for the full archive.</p>
          <button type="button" class="btn btn-secondary" id="btn-enable-live-sync" style="margin-top:8px;">Enable live WhatsApp sync (QR)…</button>
        </div>
        <div class="setting-group">
          <h3>Data</h3>""",
        1,
    )

if "wa-live-sync-settings" in t and 'class="setting-group live-sync-ui"' not in t.split("wa-live-sync-settings")[0][-200:]:
    t = t.replace(
        '<div id="wa-live-sync-settings" class="setting-group" style="display:none;">',
        '<div id="wa-live-sync-settings" class="setting-group live-sync-ui" style="display:none;">',
        1,
    )

pairs = [
    ("applyPendingWaBootstrapUi();\n", "// deferred: bootstrapWhatsAppLinking\n"),
    ("if (activeChat && isWaUiReady())", "if (activeChat && canShowChatUI())"),
    (
        "if (!isWaUiReady()) {\n        $('#welcome-qr').style.display = '';\n        $('#welcome-default').style.display = 'none';",
        "if (!canShowChatUI() && wantsLiveSyncUi()) {\n        $('#welcome-qr').style.display = '';\n        $('#welcome-default').style.display = 'none';",
    ),
    ("if (!isWaUiReady()) {", "if (!canShowChatUI()) {"),
    (
        "if (!Array.isArray(preview) || !preview.length || !isWaUiReady()) return;",
        "if (!Array.isArray(preview) || !preview.length || !canShowChatUI()) return;",
    ),
    (
        """      if (isWaUiReady()) {
        renderChatsFromState();
        adjustSyncingMainPanel();
      } else {
        const list = $('#chat-list');
        if (list) list.innerHTML = '';
      }""",
        """      if (canShowChatUI()) {
        renderChatsFromState();
        adjustSyncingMainPanel();
        ensureImportFirstWelcome();
      } else {
        const list = $('#chat-list');
        if (list) list.innerHTML = '';
      }
      updateSidebarForWaState();
      applyLiveSyncVisibility();""",
    ),
    ("if (isWaUiReady()) renderChatsFromState();", "if (canShowChatUI()) renderChatsFromState();"),
    (
        "if (!isWaUiReady()) return;\n    sortChatDataByRecency();",
        "if (!canShowChatUI()) return;\n    sortChatDataByRecency();",
    ),
]
for a, b in pairs:
    if a in t:
        t = t.replace(a, b, 1)

# switchPanel else branch
old_sp = """    } else {
      $('#panel-empty').classList.add('visible');
      // Show QR/reconnect screen until WhatsApp is fully ready.
      if (!canShowChatUI() && wantsLiveSyncUi()) {
        $('#welcome-qr').style.display = '';
        $('#welcome-default').style.display = 'none';
      } else {
        $('#welcome-qr').style.display = 'none';
        $('#welcome-default').style.display = '';
      }
    }"""
if "// Show QR/reconnect" in t and "else if (!canShowChatUI())" not in t:
    t = t.replace(
        """      // Show QR/reconnect screen until WhatsApp is fully ready.
      if (!canShowChatUI() && wantsLiveSyncUi()) {
        $('#welcome-qr').style.display = '';
        $('#welcome-default').style.display = 'none';
      } else {
        $('#welcome-qr').style.display = 'none';
        $('#welcome-default').style.display = '';
      }""",
        """      if (!canShowChatUI() && wantsLiveSyncUi()) {
        $('#welcome-qr').style.display = '';
        $('#welcome-default').style.display = 'none';
      } else if (!canShowChatUI()) {
        $('#welcome-qr').style.display = 'none';
        $('#welcome-default').style.display = hasIndexedArchive() ? '' : 'none';
      } else {
        $('#welcome-qr').style.display = 'none';
        $('#welcome-default').style.display = '';
      }""",
        1,
    )

old_sidebar = """    if (!canShowChatUI()) {
      loggedOutEl.style.display = '';
      chatListEl.style.display = 'none';
"""
if old_sidebar in t and "sidebar-import-prompt" in t and "impPrompt.style" not in t:
    t = t.replace(
        old_sidebar,
        """    if (!canShowChatUI()) {
      loggedOutEl.style.display = '';
      chatListEl.style.display = 'none';
      const impPrompt = document.getElementById('sidebar-import-prompt');
      const waPrompt = document.getElementById('sidebar-wa-prompt');
      if (impPrompt && waPrompt && _importFirstMvp && !wantsLiveSyncUi()) {
        impPrompt.style.display = '';
        waPrompt.style.display = 'none';
      } else if (impPrompt && waPrompt) {
        impPrompt.style.display = 'none';
        waPrompt.style.display = '';
      }
""",
        1,
    )

old_boot = """  (async function bootstrapWhatsAppLinking() {
    try {
      const st = await fetch('/api/wa/status').then(r => r.json());
      updateWaUI(st);

      // If not connected yet, kick off linking automatically so the QR appears without extra clicks.
      if (st && (st.state === 'DISCONNECTED' || st.state === 'LOADING') && !st.hasQr) {
        try { await fetch('/api/wa/connect', { method: 'POST' }); } catch { /* ignore */ }
      }

      // Try to load QR immediately; showQr() will keep a safety-net poll.
      const d = await fetch('/api/wa/qr').then(r => r.json());
      if (d && d.qr) showQr(d.qr);
      await refreshDash();
    } catch {
      /* ignore */
    }
  })();"""

new_boot = """  async function bootstrapWhatsAppLinking(opts = {}) {
    const forceConnect = !!opts.forceConnect;
    try {
      const cfg = await fetch('/api/app-config').then((r) => r.json()).catch(() => ({}));
      _importFirstMvp = cfg.importFirstMvp !== false;
      _waLiveSyncAutoConnect = !!cfg.waLiveSyncAutoConnect;
      if (!_showLiveSyncUi) _showLiveSyncUi = localStorage.getItem('wa_show_live_sync') === '1';

      await refreshDash();

      if (!_importFirstMvp || _waLiveSyncAutoConnect || _showLiveSyncUi || forceConnect) {
        const st = await fetch('/api/wa/status').then((r) => r.json());
        updateWaUI(st);
        if (forceConnect || (_waLiveSyncAutoConnect && st && (st.state === 'DISCONNECTED' || st.state === 'LOADING') && !st.hasQr)) {
          try { await fetch('/api/wa/connect', { method: 'POST' }); } catch { /* ignore */ }
        }
        const d = await fetch('/api/wa/qr').then((r) => r.json());
        if (d && d.qr) showQr(d.qr);
      } else {
        _waStateResolved = true;
        _waState = 'DISCONNECTED';
        applyLiveSyncVisibility();
        ensureImportFirstWelcome();
        updateSidebarForWaState();
        renderChatsFromState();
      }
    } catch { /* ignore */ }
  }

  function ensureImportFirstWelcome() {
    if (!hasIndexedArchive()) return;
    if ($('#panel-empty')?.classList.contains('visible')) {
      $('#welcome-qr').style.display = 'none';
      $('#sync-progress-panel').style.display = 'none';
      $('#wqr-loading').style.display = 'none';
      $('#welcome-default').style.display = '';
    }
  }

  void bootstrapWhatsAppLinking();"""

if old_boot in t:
    t = t.replace(old_boot, new_boot, 1)

if "_archiveMessageCount = status" not in t:
    t = t.replace(
        "chatData = Array.isArray(chats) ? chats : [];\n      sortChatDataByRecency();",
        "chatData = Array.isArray(chats) ? chats : [];\n      if (status?.stats) {\n        _archiveMessageCount = status.stats.totalMessages || 0;\n        _archiveChatCount = status.stats.totalChats || 0;\n      }\n      sortChatDataByRecency();",
        1,
    )

if "function applyPendingWaBootstrapUi()" in t and "wantsLiveSyncUi()" not in t.split("applyPendingWaBootstrapUi")[1][:120]:
    t = t.replace(
        "  function applyPendingWaBootstrapUi() {\n    const loggedOutEl",
        "  function applyPendingWaBootstrapUi() {\n    if (!wantsLiveSyncUi() || hasIndexedArchive()) return;\n    const loggedOutEl",
        1,
    )

if "getElementById('sidebar-import-btn')" not in t:
    t = t.replace(
        "  document.getElementById('wa-refresh-names')?.addEventListener('click', refreshContactNames);",
        """  document.getElementById('sidebar-import-btn')?.addEventListener('click', () => openOverlay('import'));
  document.getElementById('btn-enable-live-sync')?.addEventListener('click', () => {
    if (confirm('Enable live WhatsApp QR sync? Your phone will link as a companion device. You can keep using imports anytime.')) {
      enableLiveSyncUi();
      openOverlay('settings');
    }
  });
  document.getElementById('wa-refresh-names')?.addEventListener('click', refreshContactNames);""",
        1,
    )

p.write_text(t)
print("done")

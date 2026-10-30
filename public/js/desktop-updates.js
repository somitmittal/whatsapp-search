/**
 * Desktop auto-update UI (Electron + electron-updater).
 * Hidden in the browser; Settings → Updates when `window.desktopApp` is present.
 */

function isDesktop() {
  return window.desktopApp?.isDesktop === true
    && typeof window.desktopApp?.checkForUpdates === 'function';
}

function setText(el, text) {
  if (el) el.textContent = text || '';
}

function paintStatus(root, payload = {}) {
  if (!root) return;
  const statusEl = root.querySelector('[data-update-status]');
  const versionEl = root.querySelector('[data-update-version]');
  const checkBtn = root.querySelector('[data-update-check]');
  const installBtn = root.querySelector('[data-update-install]');
  const status = payload.status || 'idle';

  if (installBtn) {
    installBtn.hidden = status !== 'downloaded';
    installBtn.disabled = status !== 'downloaded';
  }
  if (checkBtn) {
    checkBtn.disabled = status === 'checking' || status === 'downloading';
  }

  const map = {
    idle: 'Updates download automatically when a new release is published.',
    checking: 'Checking GitHub Releases…',
    'up-to-date': `You're on the latest version${payload.version ? ` (${payload.version})` : ''}.`,
    available: `Update ${payload.version || ''} available — downloading…`,
    downloading: payload.percent != null
      ? `Downloading update… ${Math.round(payload.percent)}%`
      : 'Downloading update…',
    downloaded: `Update ${payload.version || ''} ready. Restart to install.`,
    error: payload.message
      ? `Could not update: ${payload.message}`
      : 'Could not check for updates. Use “Open releases” to download manually.',
    unavailable: 'In-app updates work in the installed desktop app (not in the browser).',
  };
  setText(statusEl, map[status] || map.idle);
  if (versionEl && payload.currentVersion) {
    versionEl.textContent = `Installed: ${payload.currentVersion}`;
  }
}

async function hydrateVersion(root) {
  try {
    const v = await window.desktopApp.getVersion?.();
    if (v) paintStatus(root, { status: 'idle', currentVersion: v });
  } catch { /* ignore */ }
}

function wireRoot(root) {
  if (!root || root.dataset.updateWired === '1') return;
  root.dataset.updateWired = '1';

  if (!isDesktop()) {
    root.hidden = false;
    paintStatus(root, { status: 'unavailable' });
    const checkBtn = root.querySelector('[data-update-check]');
    const installBtn = root.querySelector('[data-update-install]');
    if (checkBtn) checkBtn.disabled = true;
    if (installBtn) installBtn.hidden = true;
    root.querySelector('[data-update-releases]')?.addEventListener('click', (e) => {
      e.preventDefault();
      window.open('https://github.com/somitmittal/whatsapp-search/releases/latest', '_blank', 'noopener');
    });
    return;
  }

  root.hidden = false;
  void hydrateVersion(root);

  window.desktopApp.onUpdaterEvent?.((payload) => paintStatus(root, payload));

  root.querySelector('[data-update-check]')?.addEventListener('click', async () => {
    paintStatus(root, { status: 'checking' });
    try {
      const res = await window.desktopApp.checkForUpdates();
      if (!res?.ok) {
        paintStatus(root, { status: 'error', message: res?.error || 'Check failed' });
        return;
      }
      if (res.updateInfo?.version) {
        // Events will refine status; keep a hint if nothing arrives quickly.
        paintStatus(root, { status: 'available', version: res.updateInfo.version });
      }
    } catch (err) {
      paintStatus(root, { status: 'error', message: err?.message || String(err) });
    }
  });

  root.querySelector('[data-update-install]')?.addEventListener('click', async () => {
    try {
      await window.desktopApp.installUpdate();
    } catch (err) {
      paintStatus(root, { status: 'error', message: err?.message || String(err) });
    }
  });

  root.querySelector('[data-update-releases]')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (typeof window.desktopApp.openReleases === 'function') {
      void window.desktopApp.openReleases();
    } else {
      window.open('https://github.com/somitmittal/whatsapp-search/releases/latest', '_blank', 'noopener');
    }
  });
}

export function initDesktopUpdates() {
  document.querySelectorAll('[data-desktop-updates]').forEach((root) => wireRoot(root));
}

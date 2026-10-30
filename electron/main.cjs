/**
 * Electron main process — bundles WhatsApp Search as a native Mac app.
 * Spawns the Node server as a child using a real Node binary (system or bundled).
 */
const { app, BrowserWindow, shell, dialog, session, powerMonitor, powerSaveBlocker } = require('electron');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
const path = require('path');
const http = require('http');
const {
  resolveAppRoot,
  resolveServerCwd,
  resolveServerEntry,
  assertServerLaunch,
} = require('./server-launch.cjs');

const APP_NAME = 'Searchable';
const APP_ROOT = resolveAppRoot(__dirname);
const APP_ICON = path.join(APP_ROOT, 'build', 'icon.png');
const DEFAULT_PORT = 3847;
const HEALTH_PATH = '/api/health';

let serverProcess = null;
let mainWindow = null;
let serverPort = DEFAULT_PORT;
/** Loopback hook auth token (mirrors the server's SESSION_SECRET). */
let serverSessionSecret = '';

function bundledNodeName() {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function resolveNodeExecutable() {
  if (process.env.WA_SEARCH_NODE) return process.env.WA_SEARCH_NODE;

  const nodeName = bundledNodeName();

  // Dev: prefer system Node so native modules match local npm install/rebuild.
  if (!app.isPackaged) {
    try {
      if (process.platform === 'win32') {
        const nodePath = execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
        if (nodePath) return nodePath;
      } else {
        const nodePath = execFileSync('which', ['node'], { encoding: 'utf8' }).trim();
        if (nodePath) return nodePath;
      }
    } catch { /* ignore */ }
  }

  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'node', 'bin', nodeName);
    if (existsSync(bundled)) return bundled;
  }

  const devBundled = path.join(APP_ROOT, 'build', 'node', 'bin', nodeName);
  if (existsSync(devBundled)) return devBundled;

  throw new Error(
    'Node.js not found. Install Node 20+ or run the prepare-node script for your platform.',
  );
}

function getOrCreateSessionSecret(userData) {
  const secretPath = path.join(userData, '.session_secret');
  try {
    if (existsSync(secretPath)) {
      return readFileSync(secretPath, 'utf8').trim();
    }
    const secret = crypto.randomBytes(32).toString('hex');
    writeFileSync(secretPath, secret, { mode: 0o600 });
    return secret;
  } catch (err) {
    console.error('[Desktop] session secret:', err.message);
    return crypto.randomBytes(32).toString('hex');
  }
}

function loadControlPlaneDefaults() {
  const candidates = [
    path.join(APP_ROOT, 'electron', 'control-plane.defaults.json'),
    path.join(__dirname, 'control-plane.defaults.json'),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const data = JSON.parse(readFileSync(p, 'utf8'));
      return {
        controlPlaneUrl: String(data.controlPlaneUrl || '').trim().replace(/\/$/, ''),
        licenseGate: String(data.licenseGate ?? '0'),
      };
    } catch (err) {
      console.warn('[Desktop] control-plane defaults:', err.message);
    }
  }
  return { controlPlaneUrl: '', licenseGate: '0' };
}

function buildServerEnv() {
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  mkdirSync(dataDir, { recursive: true });
  const cpDefaults = loadControlPlaneDefaults();
  // Control-plane accounts/billing paused for desktop for now. Re-enable with
  // DESKTOP_ENABLE_CONTROL_PLANE=1 (then CONTROL_PLANE_URL / LICENSE_GATE apply again).
  const controlPlaneEnabled = ['1', 'true', 'yes'].includes(
    String(process.env.DESKTOP_ENABLE_CONTROL_PLANE || '').trim().toLowerCase(),
  );
  const controlPlaneUrl = controlPlaneEnabled
    ? (
      process.env.CONTROL_PLANE_URL
      || cpDefaults.controlPlaneUrl
      || ''
    ).trim().replace(/\/$/, '')
    : '';
  // Session secret also authorizes the loopback sync-quota hook (see setPhoneSyncPaused).
  const sessionSecret = process.env.SESSION_SECRET || getOrCreateSessionSecret(userData);
  serverSessionSecret = sessionSecret;

  return {
    ...process.env,
    DESKTOP_APP: '1',
    DATA_DIR: dataDir,
    WEB_HOST: '127.0.0.1',
    WEB_PORT: String(serverPort),
    HOST: '127.0.0.1',
    PORT: String(serverPort),
    SESSION_SECRET: sessionSecret,
    DEFAULT_TENANT_ID: 'legacy-default',
    // Desktop: local Ollama by default, import-first flow
    LLM_PROVIDER: process.env.LLM_PROVIDER || 'ollama',
    SUMMARY_PROVIDER: process.env.SUMMARY_PROVIDER || 'ollama',
    MEDIA_INDEX_PROVIDER: process.env.MEDIA_INDEX_PROVIDER || 'ollama',
    // Unload idle model quickly — avoids RAM spikes when app is in background
    OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || '60',
    OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL || '2',
    CONTROL_PLANE_URL: controlPlaneUrl,
    CONTROL_PLANE_PUBLIC_URL: controlPlaneEnabled
      ? (
        process.env.CONTROL_PLANE_PUBLIC_URL || controlPlaneUrl || ''
      ).trim().replace(/\/$/, '')
      : '',
    LICENSE_GATE: controlPlaneEnabled
      ? (() => {
        if (process.env.LICENSE_GATE != null && String(process.env.LICENSE_GATE).trim() !== '') {
          return String(process.env.LICENSE_GATE).trim();
        }
        if (controlPlaneUrl) return String(cpDefaults.licenseGate || '1');
        return '0';
      })()
      : '0',
  };
}

function startServer() {
  return new Promise((resolve, reject) => {
    const nodeBin = resolveNodeExecutable();
    const resourcesPath = app.isPackaged ? process.resourcesPath : APP_ROOT;
    const cwd = resolveServerCwd(APP_ROOT, resourcesPath);
    const serverEntry = resolveServerEntry(APP_ROOT, resourcesPath);
    assertServerLaunch({ entry: serverEntry, cwd, nodeBin });

    const env = buildServerEnv();
    delete env.ELECTRON_RUN_AS_NODE;

    serverProcess = spawn(nodeBin, [serverEntry], {
      cwd,
      env,
      stdio: 'pipe',
    });

    let settled = false;
    const stderrChunks = [];
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };

    serverProcess.stdout?.on('data', (chunk) => {
      process.stdout.write(`[server] ${chunk}`);
    });
    serverProcess.stderr?.on('data', (chunk) => {
      stderrChunks.push(chunk);
      process.stderr.write(`[server] ${chunk}`);
    });

    serverProcess.on('error', (err) => finish(err));
    serverProcess.on('exit', (code, signal) => {
      if (code !== null && code !== 0 && !app.isQuitting) {
        console.error(`[Desktop] Server exited: code=${code} signal=${signal}`);
      }
      if (!settled && !app.isQuitting) {
        const tail = Buffer.concat(stderrChunks).toString('utf8').trim().slice(-2000);
        finish(new Error(
          `Server exited before ready (code=${code} signal=${signal})${tail ? `\n${tail}` : ''}`,
        ));
      }
      serverProcess = null;
    });

    waitForHealth()
      .then(() => finish())
      .catch((err) => finish(err));
  });
}

function waitForHealth(maxMs = 90_000) {
  const url = `http://127.0.0.1:${serverPort}${HEALTH_PATH}`;
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() - start > maxMs) {
        reject(new Error('Server did not become ready in time'));
        return;
      }
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else setTimeout(tick, 400);
      });
      req.on('error', () => setTimeout(tick, 400));
      req.setTimeout(3000, () => {
        req.destroy();
        setTimeout(tick, 400);
      });
    };
    tick();
  });
}

function stopServer() {
  if (!serverProcess) return;
  try {
    serverProcess.kill('SIGTERM');
  } catch (_) { /* ignore */ }
  serverProcess = null;
}

function isSafeExternalUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:') {
      const host = u.hostname.toLowerCase();
      if (host !== '127.0.0.1' && host !== 'localhost') return false;
      const port = Number(u.port || 80);
      return port === Number(serverPort);
    }
    return false;
  } catch {
    return false;
  }
}

function createWindow() {
  const iconPath = existsSync(APP_ICON) ? APP_ICON : undefined;
  const origin = `http://127.0.0.1:${serverPort}`;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: iconPath,
    backgroundColor: '#f0f2f5',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.loadURL(`${origin}/?desktop=1`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isSafeExternalUrl(url)) return { action: 'deny' };
    if (url.startsWith(origin)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (url.startsWith(origin)) return;
      event.preventDefault();
      if (isSafeExternalUrl(url)) shell.openExternal(url);
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.isQuitting = false;
app.setName(APP_NAME);
app.enableSandbox();

app.whenReady().then(async () => {
  try {
    // Allow the page's own microphone (voice notes + Ask AI dictation); deny the rest.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
      if (permission === 'media') {
        try {
          const u = new URL(details?.requestingUrl || '');
          callback(u.origin === `http://127.0.0.1:${serverPort}`);
          return;
        } catch {
          callback(false);
          return;
        }
      }
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (process.platform === 'darwin' && existsSync(APP_ICON)) {
      app.dock.setIcon(APP_ICON);
    }
    await startServer();
    createWindow();
    hookSystemSleepPause();
    setupAutoUpdater();
  } catch (err) {
    console.error('[Desktop] Failed to start:', err.message);
    try {
      dialog.showErrorBox('Searchable failed to start', String(err.message || err));
    } catch (_) { /* ignore */ }
    app.quit();
  }
});

/**
 * In-app updates from GitHub Releases (same repo as desktop artifacts).
 * Requires zip (mac) / nsis (win) / AppImage (linux) + latest*.yml on the release.
 */
function setupAutoUpdater() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.warn('[Desktop] electron-updater missing:', err.message);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (err) => {
    console.warn('[Desktop] updater:', err?.message || err);
  });
  autoUpdater.on('update-available', (info) => {
    console.log('[Desktop] update available:', info?.version);
  });
  autoUpdater.on('update-downloaded', (info) => {
    const version = info?.version || 'a new version';
    const show = () => {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      dialog.showMessageBox(win || undefined, {
        type: 'info',
        title: 'Update ready',
        message: `Searchable ${version} downloaded.`,
        detail: 'Restart to install. Your local chat data stays on this computer.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall(false, true);
      }).catch(() => {});
    };
    show();
  });
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[Desktop] checkForUpdates:', err?.message || err);
    });
  }, 12_000);
}

app.on('before-quit', () => {
  app.isQuitting = true;
  try {
    if (_waBusyPollTimer) clearInterval(_waBusyPollTimer);
    if (_sleepBlockerId !== null && powerSaveBlocker.isStarted(_sleepBlockerId)) {
      powerSaveBlocker.stop(_sleepBlockerId);
    }
  } catch { /* ignore */ }
  stopServer();
});

/**
 * Pausing phone-side history syncs around sleep/lock fixes repeated phone
 * notifications ("syncing with WhatsApp Search" / "syncing stopped") on every
 * platform the app ships to: an aborted linked-device sync makes WhatsApp
 * retry and re-alert. Works via Electron powerMonitor (mac/win/linux).
 */
let _lastSyncPauseState = null;
function setPhoneSyncPaused(paused, reason) {
  if (!serverProcess || !Number.isInteger(serverPort)) return;
  if (_lastSyncPauseState === paused) return;
  _lastSyncPauseState = paused;
  try {
    const req = require('http').request({
      host: '127.0.0.1',
      port: serverPort,
      path: '/api/wa/sync-quota',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-local-sync-token': serverSessionSecret || '',
      },
      timeout: 4000,
    });
    req.on('error', () => {/* server may be restarting; nothing to do */});
    req.end(JSON.stringify({ paused: Boolean(paused), reason: reason || '' }), 'utf8');
  } catch { /* never crash the desktop shell for a sync hint */ }
}

function hookSystemSleepPause() {
  try {
    powerMonitor.on('suspend', () => setPhoneSyncPaused(true, 'suspend'));
    powerMonitor.on('resume', () => setPhoneSyncPaused(false, 'resume'));
    powerMonitor.on('lock-screen', () => setPhoneSyncPaused(true, 'lock-screen'));
    powerMonitor.on('unlock-screen', () => setPhoneSyncPaused(false, 'unlock-screen'));
  } catch (err) {
    console.warn('[Desktop] powerMonitor unavailable:', err.message);
  }
  // The permanent fix (zero impact on history pull): while the initial history sync
  // is actively downloading, hold the machine awake so the pull cannot be aborted
  // by auto-sleep. An aborted sync makes the phone retry — each retry re-alerts,
  // which is the "sync stopped" notification storm. Released as soon as sync ends.
  _ensureSyncAwakePolling();
}

/** ── Sync-awake guard ────────────────────────────────────────────── */
let _sleepBlockerId = null;
let _waBusyPollTimer = null;

function _ensureSleepBlocked(active) {
  try {
    if (active && _sleepBlockerId === null) {
      _sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      console.log('[Desktop] system auto-sleep blocked while WhatsApp history sync is running');
    } else if (!active && _sleepBlockerId !== null) {
      if (powerSaveBlocker.isStarted(_sleepBlockerId)) powerSaveBlocker.stop(_sleepBlockerId);
      _sleepBlockerId = null;
      console.log('[Desktop] system auto-sleep allowed again (sync idle)');
    }
  } catch (err) {
    console.warn('[Desktop] powerSaveBlocker unavailable:', err.message);
  }
}

function _pollWaBusyOnce() {
  if (!serverProcess || !Number.isInteger(serverPort)) return;
  const req = http.request({
    host: '127.0.0.1',
    port: serverPort,
    path: '/api/wa/local-status',
    method: 'GET',
    headers: { 'x-local-sync-token': serverSessionSecret || '' },
    timeout: 4000,
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        const d = JSON.parse(body || '{}');
        _ensureSleepBlocked(Boolean(d.syncing));
      } catch { /* ignore malformed */ }
    });
  });
  req.on('error', () => { /* server restarting; next tick retries */ });
  req.end();
}

function _ensureSyncAwakePolling() {
  _pollWaBusyOnce();
  if (_waBusyPollTimer) return;
  _waBusyPollTimer = setInterval(_pollWaBusyOnce, 30 * 1000);
}

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverProcess) {
    createWindow();
  }
});

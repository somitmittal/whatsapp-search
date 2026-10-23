/**
 * Electron main process — bundles WhatsApp Search as a native Mac app.
 * Spawns the Node server as a child using a real Node binary (system or bundled).
 */
const { app, BrowserWindow, shell, dialog, session } = require('electron');
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
        licenseGate: String(data.licenseGate ?? '1'),
      };
    } catch (err) {
      console.warn('[Desktop] control-plane defaults:', err.message);
    }
  }
  return { controlPlaneUrl: '', licenseGate: '1' };
}

function buildServerEnv() {
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  mkdirSync(dataDir, { recursive: true });
  const cpDefaults = loadControlPlaneDefaults();
  const controlPlaneUrl = (
    process.env.CONTROL_PLANE_URL
    || cpDefaults.controlPlaneUrl
    || ''
  ).trim().replace(/\/$/, '');
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
    // Hosted control plane for accounts/billing. Baked at release via control-plane.defaults.json.
    CONTROL_PLANE_URL: controlPlaneUrl,
    CONTROL_PLANE_PUBLIC_URL: (
      process.env.CONTROL_PLANE_PUBLIC_URL || controlPlaneUrl || ''
    ).trim().replace(/\/$/, ''),
    LICENSE_GATE: process.env.LICENSE_GATE || cpDefaults.licenseGate || '1',
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
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (process.platform === 'darwin' && existsSync(APP_ICON)) {
      app.dock.setIcon(APP_ICON);
    }
    await startServer();
    createWindow();
    hookSystemSleepPause();
  } catch (err) {
    console.error('[Desktop] Failed to start:', err.message);
    try {
      dialog.showErrorBox('Searchable failed to start', String(err.message || err));
    } catch (_) { /* ignore */ }
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
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
    const { powerMonitor } = require('electron');
    powerMonitor.on('suspend', () => setPhoneSyncPaused(true, 'suspend'));
    powerMonitor.on('resume', () => setPhoneSyncPaused(false, 'resume'));
    powerMonitor.on('lock-screen', () => setPhoneSyncPaused(true, 'lock-screen'));
    powerMonitor.on('unlock-screen', () => setPhoneSyncPaused(false, 'unlock-screen'));
  } catch (err) {
    console.warn('[Desktop] powerMonitor unavailable:', err.message);
  }
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

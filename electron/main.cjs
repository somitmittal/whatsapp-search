/**
 * Electron main process — bundles WhatsApp Search as a native Mac app.
 * Spawns the Node server as a child using a real Node binary (system or bundled).
 */
const { app, BrowserWindow, shell } = require('electron');
const { spawn, execSync } = require('child_process');
const crypto = require('crypto');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
const path = require('path');
const http = require('http');

const APP_NAME = 'Searchable';
const APP_ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(APP_ROOT, 'src', 'index.js');
const APP_ICON = path.join(APP_ROOT, 'build', 'icon.png');
const DEFAULT_PORT = 3847;
const HEALTH_PATH = '/api/health';

let serverProcess = null;
let mainWindow = null;
let serverPort = DEFAULT_PORT;

function resolveNodeExecutable() {
  if (process.env.WA_SEARCH_NODE) return process.env.WA_SEARCH_NODE;

  // Dev: prefer system Node so native modules match local npm install/rebuild.
  if (!app.isPackaged) {
    try {
      const nodePath = execSync('which node', { encoding: 'utf8' }).trim();
      if (nodePath) return nodePath;
    } catch { /* ignore */ }
  }

  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'node', 'bin', 'node');
    if (existsSync(bundled)) return bundled;
  }

  const devBundled = path.join(APP_ROOT, 'build', 'node', 'bin', 'node');
  if (existsSync(devBundled)) return devBundled;

  throw new Error(
    'Node.js not found. Install Node 20+ (brew install node) or run: bash scripts/prepare-node-mac.sh',
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

function buildServerEnv() {
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  mkdirSync(dataDir, { recursive: true });

  return {
    ...process.env,
    DESKTOP_APP: '1',
    DATA_DIR: dataDir,
    WEB_HOST: '127.0.0.1',
    WEB_PORT: String(serverPort),
    HOST: '127.0.0.1',
    PORT: String(serverPort),
    SESSION_SECRET: process.env.SESSION_SECRET || getOrCreateSessionSecret(userData),
    DEFAULT_TENANT_ID: 'legacy-default',
    // Desktop: local Ollama by default, import-first flow
    LLM_PROVIDER: process.env.LLM_PROVIDER || 'ollama',
    SUMMARY_PROVIDER: process.env.SUMMARY_PROVIDER || 'ollama',
    MEDIA_INDEX_PROVIDER: process.env.MEDIA_INDEX_PROVIDER || 'ollama',
    // Unload idle model quickly — avoids RAM spikes when app is in background
    OLLAMA_KEEP_ALIVE: process.env.OLLAMA_KEEP_ALIVE || '60',
    OLLAMA_NUM_PARALLEL: process.env.OLLAMA_NUM_PARALLEL || '2',
  };
}

function startServer() {
  return new Promise((resolve, reject) => {
    const nodeBin = resolveNodeExecutable();
    const env = buildServerEnv();
    delete env.ELECTRON_RUN_AS_NODE;

    serverProcess = spawn(nodeBin, [SERVER_ENTRY], {
      cwd: APP_ROOT,
      env,
      stdio: 'pipe',
    });

    serverProcess.stdout?.on('data', (chunk) => {
      process.stdout.write(`[server] ${chunk}`);
    });
    serverProcess.stderr?.on('data', (chunk) => {
      process.stderr.write(`[server] ${chunk}`);
    });

    serverProcess.on('error', reject);
    serverProcess.on('exit', (code, signal) => {
      if (code !== null && code !== 0 && !app.isQuitting) {
        console.error(`[Desktop] Server exited: code=${code} signal=${signal}`);
      }
      serverProcess = null;
    });

    waitForHealth()
      .then(resolve)
      .catch(reject);
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

function createWindow() {
  const iconPath = existsSync(APP_ICON) ? APP_ICON : undefined;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: iconPath,
    backgroundColor: '#f0f2f5',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/?desktop=1`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.isQuitting = false;
app.setName(APP_NAME);

app.whenReady().then(async () => {
  try {
    if (process.platform === 'darwin' && existsSync(APP_ICON)) {
      app.dock.setIcon(APP_ICON);
    }
    await startServer();
    createWindow();
  } catch (err) {
    console.error('[Desktop] Failed to start:', err.message);
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopServer();
});

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverProcess) {
    createWindow();
  }
});

/**
 * Paths for the bundled Node child that runs src/index.js.
 * Official Node cannot read Electron asar archives, and cannot use an asar
 * file as cwd (spawn ENOTDIR).
 */
const path = require('path');
const { existsSync } = require('fs');

function resolveAppRoot(electronDirname) {
  return path.join(electronDirname, '..');
}

function resolveServerCwd(appRoot, resourcesPath) {
  if (typeof appRoot === 'string' && appRoot.endsWith('.asar')) {
    return resourcesPath;
  }
  return appRoot;
}

function resolveServerEntry(appRoot, resourcesPath) {
  const candidates = [
    path.join(appRoot, 'src', 'index.js'),
    path.join(resourcesPath || '', 'app.asar.unpacked', 'src', 'index.js'),
    path.join(resourcesPath || '', 'app', 'src', 'index.js'),
  ];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

function assertServerLaunch({ entry, cwd, nodeBin }) {
  if (!nodeBin || !existsSync(nodeBin)) {
    throw new Error(`Bundled Node not found: ${nodeBin || '(empty)'}`);
  }
  if (!cwd || !existsSync(cwd)) {
    throw new Error(`Server working directory is missing: ${cwd || '(empty)'}`);
  }
  const cwdStat = require('fs').statSync(cwd);
  if (!cwdStat.isDirectory()) {
    throw new Error(`Server working directory is not a directory: ${cwd}`);
  }
  if (!entry || !existsSync(entry)) {
    throw new Error(
      `Server entry not found: ${entry || '(empty)'}. Desktop builds must ship src/ outside asar (asar: false).`,
    );
  }
}

module.exports = {
  resolveAppRoot,
  resolveServerCwd,
  resolveServerEntry,
  assertServerLaunch,
};

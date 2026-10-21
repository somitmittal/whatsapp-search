/**
 * 1) Fail the build if better-sqlite3 cannot load under the bundled Node ABI
 *    (electron-builder's default npmRebuild retargets addons to Electron).
 * 2) Hoist any production modules electron-builder left only in nested
 *    node_modules (hoisted deps like call-bind-apply-helpers) so requires from
 *    sibling packages resolve. Then smoke-test with module paths clamped to the
 *    packaged app — otherwise Node walks up into the CI checkout and false-passes.
 * 3) On macOS, deep ad-hoc sign so Gatekeeper does not report a damaged app.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROJECT_NM = path.join(PROJECT_ROOT, 'node_modules');
const MAX_HOIST_ROUNDS = 40;

function resourcesDir(context) {
  const appName = context.packager.appInfo.productFilename;
  if (context.electronPlatformName === 'darwin') {
    return path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

function parseMissingModule(stderr) {
  const text = String(stderr || '');
  const m = text.match(/Cannot find module '([^']+)'/);
  return m ? m[1] : null;
}

/** Top-level package dir name for a require id (`@scope/name/...` → `@scope/name`). */
function packageRootId(moduleId) {
  const id = String(moduleId || '').replace(/\\/g, '/');
  if (id.startsWith('@')) {
    const parts = id.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : id;
  }
  return id.split('/')[0];
}

function copyPackageFromProject(appNm, pkgId) {
  const src = path.join(PROJECT_NM, ...pkgId.split('/'));
  const dest = path.join(appNm, ...pkgId.split('/'));
  if (!fs.existsSync(src)) {
    throw new Error(`[afterPack] Missing ${pkgId} in project node_modules; cannot hoist into package`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
  console.log(`[afterPack] Hoisted ${pkgId} → app/node_modules`);
}

/**
 * Run smoke requires with Module._nodeModulePaths clamped under appDir so resolution
 * cannot escape into the electron-builder working tree (CI false-pass).
 */
function runIsolatedSmoke(nodeBin, appDir) {
  const preload = path.join(os.tmpdir(), `searchable-pack-smoke-preload-${process.pid}.cjs`);
  // realpath: macOS /tmp → /private/tmp; without this the clamp drops app/node_modules.
  const appRoot = fs.realpathSync(appDir);
  const appDirJson = JSON.stringify(appRoot);
  fs.writeFileSync(
    preload,
    `
const Module = require('module');
const path = require('path');
const fs = require('fs');
const appRoot = ${appDirJson};
const orig = Module._nodeModulePaths;
Module._nodeModulePaths = function (from) {
  return orig.call(this, from).filter((p) => {
    let abs = p;
    try { abs = fs.realpathSync(p); } catch { /* keep p */ }
    const rel = path.relative(appRoot, abs);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
};
`,
    'utf8',
  );

  const script = [
    "require('better-sqlite3');",
    "require('googleapis');",
    "require('exceljs');",
    "require('qs');",
    "require('dunder-proto/get');",
    "require('call-bind-apply-helpers');",
    "require('es-abstract-get/GetMethod');",
    "console.log('packaged dependency smoke ok');",
  ].join('');

  try {
    execFileSync(nodeBin, ['-r', preload, '-e', script], {
      cwd: appDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_PATH: '' },
    });
    return { ok: true, stderr: '' };
  } catch (err) {
    const buf = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b || ''));
    const stderr = `${buf(err.stderr)}${buf(err.stdout)}${err.message || ''}`;
    return { ok: false, stderr };
  } finally {
    try { fs.unlinkSync(preload); } catch { /* ignore */ }
  }
}

function verifyBundledApp(context) {
  const resources = resourcesDir(context);
  const nodeName = context.electronPlatformName === 'win32' ? 'node.exe' : 'node';
  const nodeBin = path.join(resources, 'node', 'bin', nodeName);
  const appDir = path.join(resources, 'app');
  const appNm = path.join(appDir, 'node_modules');

  console.log(`[afterPack] Verify bundled Node modules with ${nodeBin}`);

  for (let round = 0; round < MAX_HOIST_ROUNDS; round += 1) {
    const result = runIsolatedSmoke(nodeBin, appDir);
    if (result.ok) {
      process.stdout.write('packaged dependency smoke ok\n');
      return;
    }
    const missing = parseMissingModule(result.stderr);
    if (!missing) {
      console.error(result.stderr);
      throw new Error('[afterPack] Packaged app smoke failed without a MODULE_NOT_FOUND to repair');
    }
    const pkgId = packageRootId(missing);
    if (fs.existsSync(path.join(appNm, ...pkgId.split('/')))) {
      console.error(result.stderr);
      throw new Error(
        `[afterPack] ${pkgId} is present but still failed to load — see stderr above`,
      );
    }
    copyPackageFromProject(appNm, pkgId);
  }
  throw new Error(`[afterPack] Exceeded ${MAX_HOIST_ROUNDS} hoist rounds; dependency graph still incomplete`);
}

exports.default = async function afterPack(context) {
  verifyBundledApp(context);

  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterPack] Deep ad-hoc codesign: ${appPath}`);
  // Do not pass --options runtime here — that needs a Developer ID identity + entitlements
  // and crashes ad-hoc builds (dyld Team ID mismatch).
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });
};

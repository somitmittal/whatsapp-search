/**
 * 1) Fail the build if better-sqlite3 cannot load under the bundled Node ABI
 *    (electron-builder's default npmRebuild retargets addons to Electron).
 * 2) Fail if the server entry's production require graph is incomplete — electron-builder
 *    sometimes omits hoisted transitive deps (seen as MODULE_NOT_FOUND after download).
 * 3) On macOS, deep ad-hoc sign so Gatekeeper does not report a damaged app.
 */
const { execFileSync } = require('child_process');
const path = require('path');

function resourcesDir(context) {
  const appName = context.packager.appInfo.productFilename;
  if (context.electronPlatformName === 'darwin') {
    return path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

function verifyBundledApp(context) {
  const resources = resourcesDir(context);
  const nodeName = context.electronPlatformName === 'win32' ? 'node.exe' : 'node';
  const nodeBin = path.join(resources, 'node', 'bin', nodeName);
  const appDir = path.join(resources, 'app');
  console.log(`[afterPack] Verify bundled Node modules with ${nodeBin}`);
  // Keep this list aligned with modules that have broken packaged installs before.
  execFileSync(
    nodeBin,
    ['-e', [
      "require('better-sqlite3');",
      "require('call-bind-apply-helpers');",
      "require('es-abstract-get/GetMethod');",
      "require('exceljs');",
      "require('googleapis');",
      "require('./src/gmail/gmail-sync.js');",
      "console.log('packaged dependency smoke ok');",
    ].join('')],
    { cwd: appDir, stdio: 'inherit' },
  );
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

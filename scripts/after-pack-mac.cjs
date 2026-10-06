/**
 * 1) Fail the build if better-sqlite3 cannot load under the bundled Node ABI
 *    (electron-builder's default npmRebuild retargets addons to Electron).
 * 2) On macOS, deep ad-hoc sign so Gatekeeper does not report a damaged app.
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

function verifyBundledSqlite(context) {
  const resources = resourcesDir(context);
  const nodeName = context.electronPlatformName === 'win32' ? 'node.exe' : 'node';
  const nodeBin = path.join(resources, 'node', 'bin', nodeName);
  const appDir = path.join(resources, 'app');
  console.log(`[afterPack] Verify better-sqlite3 with ${nodeBin}`);
  execFileSync(
    nodeBin,
    ['-e', "require('better-sqlite3'); console.log('better-sqlite3 ok for bundled Node')"],
    { cwd: appDir, stdio: 'inherit' },
  );
}

exports.default = async function afterPack(context) {
  verifyBundledSqlite(context);

  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterPack] Deep ad-hoc codesign: ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });
};

/**
 * Ensure the .app has a deep ad-hoc signature with sealed resources.
 * electron-builder with identity "-" can leave linker-signed stubs that
 * macOS reports as "damaged" / "code has no resources".
 */
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterPack] Deep ad-hoc codesign: ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
};

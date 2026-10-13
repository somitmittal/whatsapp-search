/**
 * Resolve a writable data directory.
 * On Render, `DATA_DIR=/var/data` only works when a Disk is mounted there.
 * Without a disk, mkdir fails with EACCES — fall back to ./data in the app root.
 */
import { accessSync, constants, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { isAbsolute, join, resolve } from 'path';

function canUseDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    const probe = join(dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} root App root (repo root)
 * @param {string | undefined} envDataDir process.env.DATA_DIR
 * @returns {{ dataDir: string, requestedDir: string, fellBack: boolean }}
 */
export function resolveWritableDataDir(root, envDataDir) {
  const raw = String(envDataDir || '').trim();
  const requested = raw
    ? (isAbsolute(raw) ? raw : resolve(root, raw))
    : resolve(root, 'data');
  const fallback = resolve(root, 'data');

  if (canUseDir(requested)) {
    return { dataDir: requested, requestedDir: requested, fellBack: false };
  }

  if (requested !== fallback && canUseDir(fallback)) {
    console.warn(
      `[config] DATA_DIR="${requested}" is not writable (EACCES/ENOENT). `
      + `Falling back to "${fallback}". `
      + 'On Render: either attach a Disk mounted at that path, or remove DATA_DIR so ./data is used.',
    );
    return { dataDir: fallback, requestedDir: requested, fellBack: true };
  }

  throw new Error(
    `Cannot create a writable data directory. Tried "${requested}"`
    + (requested !== fallback ? ` and "${fallback}"` : '')
    + '. On Render, add a Disk at /var/data or unset DATA_DIR.',
  );
}

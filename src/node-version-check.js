import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Ensures Searchable runs under Node 22 (required by native SQLite ABI bindings and engines).
 * If started under a different Node version (e.g. Node 25 in default Homebrew path),
 * transparently respawns using the installed Node 22 binary if present.
 */
function findNode22Binary() {
  if (process.env.NODE22_PATH && existsSync(process.env.NODE22_PATH)) {
    return process.env.NODE22_PATH;
  }
  const known = [
    '/opt/homebrew/opt/node@22/bin/node',
    '/usr/local/opt/node@22/bin/node',
  ];
  for (const p of known) {
    if (existsSync(p)) return p;
  }
  const home = process.env.HOME || '';
  if (home) {
    // Check nvm
    const nvmDir = join(home, '.nvm', 'versions', 'node');
    if (existsSync(nvmDir)) {
      try {
        const entries = readdirSync(nvmDir).filter((d) => d.startsWith('v22.'));
        if (entries.length > 0) {
          entries.sort().reverse();
          const p = join(nvmDir, entries[0], 'bin', 'node');
          if (existsSync(p)) return p;
        }
      } catch {}
    }
    // Check asdf
    const asdfDir = join(home, '.asdf', 'installs', 'nodejs');
    if (existsSync(asdfDir)) {
      try {
        const entries = readdirSync(asdfDir).filter((d) => d.startsWith('22.'));
        if (entries.length > 0) {
          entries.sort().reverse();
          const p = join(asdfDir, entries[0], 'bin', 'node');
          if (existsSync(p)) return p;
        }
      } catch {}
    }
  }
  return null;
}

const currentMajor = process.versions.node ? process.versions.node.split('.')[0] : '';
if (currentMajor && currentMajor !== '22' && !process.env._SEARCHABLE_RESPAWNED_NODE22) {
  const node22 = findNode22Binary();
  if (node22) {
    const node22Dir = dirname(node22);
    const args = [...process.execArgv, ...process.argv.slice(1)];
    const result = spawnSync(node22, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        _SEARCHABLE_RESPAWNED_NODE22: '1',
        PATH: `${node22Dir}:${process.env.PATH || ''}`,
      },
    });
    if (result.signal) {
      process.kill(process.pid, result.signal);
    }
    process.exit(result.status ?? 0);
  } else {
    console.warn(
      `\n[Searchable] Warning: Running on Node ${process.version}. ` +
      `Native modules (better-sqlite3) require Node 22 (NODE_MODULE_VERSION 127).\n` +
      `If you experience ABI errors, install Node 22 or run: source scripts/init.sh\n`
    );
  }
}

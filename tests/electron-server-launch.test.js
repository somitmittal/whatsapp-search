import { createRequire } from 'module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test } from '@jest/globals';

const require = createRequire(import.meta.url);
const {
  resolveAppRoot,
  resolveServerCwd,
  resolveServerEntry,
  assertServerLaunch,
} = require('../electron/server-launch.cjs');

describe('electron server-launch', () => {
  test('app root is the parent of the electron folder', () => {
    expect(resolveAppRoot('/App/Contents/Resources/app/electron')).toBe(
      '/App/Contents/Resources/app',
    );
  });

  test('cwd falls back off an asar file so spawn does not get ENOTDIR', () => {
    const asar = '/App/Contents/Resources/app.asar';
    const resources = '/App/Contents/Resources';
    expect(resolveServerCwd(asar, resources)).toBe(resources);
    expect(resolveServerCwd('/App/Contents/Resources/app', resources)).toBe(
      '/App/Contents/Resources/app',
    );
  });

  test('prefers src on a real directory over a missing asar path', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'searchable-launch-'));
    try {
      const appRoot = path.join(tmp, 'app');
      mkdirSync(path.join(appRoot, 'src'), { recursive: true });
      writeFileSync(path.join(appRoot, 'src', 'index.js'), 'export {};\n');
      expect(resolveServerEntry(appRoot, path.join(tmp, 'Resources'))).toBe(
        path.join(appRoot, 'src', 'index.js'),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('assertServerLaunch rejects an asar file used as cwd', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'searchable-launch-'));
    try {
      const asar = path.join(tmp, 'app.asar');
      writeFileSync(asar, 'not-a-directory');
      const nodeBin = process.execPath;
      expect(() =>
        assertServerLaunch({
          entry: asar,
          cwd: asar,
          nodeBin,
        }),
      ).toThrow(/not a directory/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

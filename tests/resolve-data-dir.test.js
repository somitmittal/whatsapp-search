import { describe, expect, test, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, chmodSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { resolveWritableDataDir } from '../src/storage/resolve-data-dir.js';

describe('resolveWritableDataDir', () => {
  let tmp;

  afterEach(() => {
    if (tmp) {
      try { chmodSync(tmp, 0o755); } catch { /* ignore */ }
      rmSync(tmp, { recursive: true, force: true });
      tmp = null;
    }
  });

  test('uses requested dir when writable', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'data-ok-'));
    const target = path.join(tmp, 'var-data');
    const r = resolveWritableDataDir(tmp, target);
    expect(r.dataDir).toBe(target);
    expect(r.fellBack).toBe(false);
  });

  test('falls back to ./data when requested path is not writable', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'data-fb-'));
    const lockedParent = path.join(tmp, 'locked');
    mkdirSync(lockedParent, { recursive: true });
    // Make parent unwritable so mkdir of child fails (best-effort; skip if platform ignores).
    try {
      chmodSync(lockedParent, 0o555);
    } catch {
      return;
    }
    const requested = path.join(lockedParent, 'var-data');
    const r = resolveWritableDataDir(tmp, requested);
    expect(r.fellBack).toBe(true);
    expect(r.dataDir).toBe(path.join(tmp, 'data'));
    try { chmodSync(lockedParent, 0o755); } catch { /* ignore */ }
  });

  test('default relative data dir under root', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'data-def-'));
    const r = resolveWritableDataDir(tmp, undefined);
    expect(r.dataDir).toBe(path.join(tmp, 'data'));
    expect(r.fellBack).toBe(false);
  });
});

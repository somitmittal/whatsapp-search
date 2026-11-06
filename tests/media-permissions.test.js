import { createRequire } from 'module';
import { describe, expect, test } from '@jest/globals';

const require = createRequire(import.meta.url);
const {
  isLocalAppOrigin,
  shouldAllowPermission,
} = require('../electron/media-permissions.cjs');

describe('electron media permissions', () => {
  test('accepts loopback origins on the desktop server port', () => {
    expect(isLocalAppOrigin('http://127.0.0.1:3000/', 3000)).toBe(true);
    expect(isLocalAppOrigin('http://localhost:3000/gpt', 3000)).toBe(true);
    expect(isLocalAppOrigin('http://127.0.0.1:3000', 3999)).toBe(false);
    expect(isLocalAppOrigin('https://evil.example/', 3000)).toBe(false);
  });

  test('allows media and fullscreen for the local app only', () => {
    expect(shouldAllowPermission('media', 'http://127.0.0.1:3000/', 3000)).toBe(true);
    expect(shouldAllowPermission('fullscreen', 'http://127.0.0.1:3000/?desktop=1', 3000)).toBe(true);
    expect(shouldAllowPermission('notifications', 'http://127.0.0.1:3000/', 3000)).toBe(false);
    expect(shouldAllowPermission('fullscreen', 'https://evil.example/', 3000)).toBe(false);
  });
});

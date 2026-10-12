import { describe, expect, test } from '@jest/globals';
import {
  findAssetForPlatform,
  normalizePlatform,
  trackedDownloadPath,
} from '../src/control-plane/platforms.js';

describe('control-plane platforms', () => {
  test('normalizes platform aliases', () => {
    expect(normalizePlatform('mac-arm64')).toBe('mac-arm64');
    expect(normalizePlatform('darwin-arm64')).toBe('mac-arm64');
    expect(normalizePlatform('win-x64')).toBe('windows');
    expect(normalizePlatform('nope')).toBe(null);
  });

  test('finds release assets by platform', () => {
    const assets = [
      { name: 'Searchable-1.0.9-mac-arm64.dmg', url: 'https://example/a' },
      { name: 'Searchable-1.0.9-win-x64.exe', url: 'https://example/w' },
    ];
    expect(findAssetForPlatform(assets, 'mac-arm64')?.url).toContain('/a');
    expect(findAssetForPlatform(assets, 'windows')?.url).toContain('/w');
    expect(findAssetForPlatform(assets, 'linux')).toBe(null);
  });

  test('builds tracked download paths with UTM', () => {
    expect(trackedDownloadPath('windows', { utm_source: 'linkedin' })).toBe(
      '/api/releases/download/windows?utm_source=linkedin',
    );
  });
});

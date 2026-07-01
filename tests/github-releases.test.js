import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { clearReleaseCacheForTests, getLatestGitHubRelease } from '../src/releases/github-releases.js';

describe('github-releases', () => {
  const origFetch = global.fetch;
  const origCacheMs = process.env.GITHUB_RELEASES_CACHE_MS;

  beforeEach(() => {
    clearReleaseCacheForTests();
    process.env.GITHUB_RELEASES_CACHE_MS = '60000';
  });

  afterEach(() => {
    global.fetch = origFetch;
    clearReleaseCacheForTests();
    if (origCacheMs === undefined) delete process.env.GITHUB_RELEASES_CACHE_MS;
    else process.env.GITHUB_RELEASES_CACHE_MS = origCacheMs;
  });

  test('caches successful GitHub release responses', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v1.0.0',
          name: 'v1.0.0',
          published_at: '2026-01-01T00:00:00Z',
          html_url: 'https://github.com/somitmittal/whatsapp-search/releases/tag/v1.0.0',
          assets: [{ name: 'Searchable-1.0.0-mac-arm64.dmg', browser_download_url: 'https://example.com/a.dmg', size: 100 }],
        }),
      };
    };

    const first = await getLatestGitHubRelease('somitmittal/whatsapp-search');
    const second = await getLatestGitHubRelease('somitmittal/whatsapp-search');
    expect(first.version).toBe('v1.0.0');
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
  });

  test('returns stale cache when rate limited after a prior success', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tag_name: 'v1.0.0',
            html_url: 'https://github.com/somitmittal/whatsapp-search/releases/tag/v1.0.0',
            assets: [],
          }),
        };
      }
      return { ok: false, status: 403, text: async () => 'rate limit' };
    };

    process.env.GITHUB_RELEASES_CACHE_MS = '0';
    await getLatestGitHubRelease('somitmittal/whatsapp-search');
    const stale = await getLatestGitHubRelease('somitmittal/whatsapp-search');
    expect(stale.stale).toBe(true);
    expect(stale.version).toBe('v1.0.0');
    expect(calls).toBe(2);
  });
});

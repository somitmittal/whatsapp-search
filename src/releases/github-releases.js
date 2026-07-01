import config from '../config.js';

function cacheMs() {
  const raw = process.env.GITHUB_RELEASES_CACHE_MS;
  if (raw != null && String(raw).trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 60 * 60 * 1000;
}

let cache = { at: 0, data: null };

function releasePageUrl(repo) {
  return `https://github.com/${repo}/releases/latest`;
}

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'searchable-desktop-download',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const ghToken = (process.env.GITHUB_TOKEN || '').trim();
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;
  return headers;
}

function mapRelease(release, repo) {
  const allAssets = (release.assets || []).map((a) => ({
    name: a.name,
    url: a.browser_download_url,
    size: a.size,
  }));
  return {
    version: release.tag_name,
    name: release.name,
    publishedAt: release.published_at,
    releasePage: release.html_url || releasePageUrl(repo),
    allAssets,
    cached: false,
  };
}

async function fetchFromGitHub(repo) {
  const ghRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubHeaders(),
  });
  if (ghRes.status === 404) {
    const err = new Error('No published release yet. Push a version tag (e.g. v1.0.0) to trigger the release workflow.');
    err.status = 404;
    err.releasePage = releasePageUrl(repo);
    throw err;
  }
  if (!ghRes.ok) {
    const text = await ghRes.text().catch(() => '');
    const err = new Error(`GitHub API error: ${ghRes.status} ${text.slice(0, 160)}`);
    err.status = ghRes.status;
    err.releasePage = releasePageUrl(repo);
    throw err;
  }
  const release = await ghRes.json();
  return mapRelease(release, repo);
}

/**
 * Latest GitHub release for desktop downloads. Cached to avoid shared-IP rate limits on Render.
 * @param {string} [repoOverride]
 */
export async function getLatestGitHubRelease(repoOverride) {
  const repo = (repoOverride || config.githubRepo || '').trim();
  if (!repo) {
    const err = new Error('GITHUB_REPO is not configured');
    err.status = 503;
    throw err;
  }

  const now = Date.now();
  if (cache.data && now - cache.at < cacheMs()) {
    return { ...cache.data, cached: true };
  }

  try {
    const data = await fetchFromGitHub(repo);
    cache = { at: now, data };
    return data;
  } catch (err) {
    if (cache.data && (err.status === 403 || err.status === 429)) {
      return { ...cache.data, cached: true, stale: true };
    }
    throw err;
  }
}

/** @param {import('express').Response} res */
export function sendReleaseError(res, err, repo) {
  const releasePage = err.releasePage || (repo ? releasePageUrl(repo) : '');
  const status = err.status === 404 ? 404 : (err.status === 503 ? 503 : 502);
  return res.status(status).json({
    error: err.message,
    releasePage,
    hint: status === 403 || err.status === 429
      ? 'Set GITHUB_TOKEN in Render environment for higher API limits, or use the GitHub Releases link below.'
      : undefined,
  });
}

export function clearReleaseCacheForTests() {
  cache = { at: 0, data: null };
}

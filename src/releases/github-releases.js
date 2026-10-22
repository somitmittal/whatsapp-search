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

/** Reject empty / docs-placeholder values that would cause GitHub 401 Bad credentials. */
export function usableGithubToken(raw = process.env.GITHUB_TOKEN) {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (/^<.*>$/.test(t)) return '';
  if (/read-only\s*PAT/i.test(t)) return '';
  if (/^(your[-_]?token|changeme|xxx+|placeholder)/i.test(t)) return '';
  return t;
}

function githubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'searchable-desktop-download',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function mapRelease(release, repo) {
  const allAssets = (release.assets || []).map((a) => ({
    name: a.name,
    url: a.browser_download_url,
    size: a.size,
    downloadCount: typeof a.download_count === 'number' ? a.download_count : 0,
  }));
  return {
    version: release.tag_name,
    name: release.name,
    publishedAt: release.published_at,
    releasePage: release.html_url || releasePageUrl(repo),
    allAssets,
    githubDownloadsTotal: allAssets.reduce((n, a) => n + (a.downloadCount || 0), 0),
    cached: false,
  };
}

async function fetchFromGitHub(repo, { token } = {}) {
  const ghRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubHeaders(token),
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

  const token = usableGithubToken();
  try {
    const data = await fetchFromGitHub(repo, { token });
    cache = { at: now, data };
    return data;
  } catch (err) {
    let finalErr = err;
    // Bad / revoked PAT — retry once unauthenticated (public repos only).
    if (token && err.status === 401) {
      try {
        const data = await fetchFromGitHub(repo, { token: '' });
        cache = { at: now, data };
        console.warn('[releases] GITHUB_TOKEN rejected by GitHub (401); used unauthenticated request');
        return data;
      } catch (retryErr) {
        finalErr = retryErr;
      }
    }
    if (cache.data && (finalErr.status === 403 || finalErr.status === 429 || finalErr.status === 401)) {
      return { ...cache.data, cached: true, stale: true };
    }
    throw finalErr;
  }
}

/** @param {import('express').Response} res */
export function sendReleaseError(res, err, repo) {
  const releasePage = err.releasePage || (repo ? releasePageUrl(repo) : '');
  const status = err.status === 404 ? 404 : (err.status === 503 ? 503 : 502);
  let hint;
  if (err.status === 401) {
    hint = 'GITHUB_TOKEN on Render is invalid — set a real read-only PAT, or remove the env var for public repos.';
  } else if (err.status === 403 || err.status === 429) {
    hint = 'GitHub rate-limited this host. Set a real GITHUB_TOKEN (read-only PAT) on Render, or use the GitHub Releases link below.';
  }
  return res.status(status).json({
    error: err.message,
    releasePage,
    hint,
  });
}

export function clearReleaseCacheForTests() {
  cache = { at: 0, data: null };
}

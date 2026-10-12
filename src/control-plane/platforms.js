/** Canonical platform keys for download analytics + release redirects. */
export const PLATFORMS = Object.freeze({
  'mac-arm64': {
    id: 'mac-arm64',
    label: 'macOS Apple Silicon',
    match: /Apple.Silicon|mac.*arm64|darwin.*arm64/i,
  },
  'mac-x64': {
    id: 'mac-x64',
    label: 'macOS Intel',
    match: /macOS-Intel|mac.*x64|darwin.*(x64|x86)/i,
  },
  windows: {
    id: 'windows',
    label: 'Windows',
    match: /Windows|win.*\.exe$/i,
  },
  linux: {
    id: 'linux',
    label: 'Linux',
    match: /Linux|linux.*\.AppImage$/i,
  },
});

export function normalizePlatform(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (PLATFORMS[key]) return key;
  if (key === 'mac' || key === 'darwin-arm64' || key === 'macos-arm64') return 'mac-arm64';
  if (key === 'darwin-x64' || key === 'macos-x64' || key === 'mac-intel') return 'mac-x64';
  if (key === 'win' || key === 'win32' || key === 'win-x64') return 'windows';
  if (key === 'linux-x64' || key === 'appimage') return 'linux';
  return null;
}

export function findAssetForPlatform(allAssets, platformId) {
  const meta = PLATFORMS[platformId];
  if (!meta || !Array.isArray(allAssets)) return null;
  return allAssets.find((a) => meta.match.test(a.name || '')) || null;
}

export function trackedDownloadPath(platformId, query = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v != null && String(v).trim() !== '') qs.set(k, String(v));
  }
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return `/api/releases/download/${platformId}${suffix}`;
}

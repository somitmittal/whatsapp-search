/**
 * Which Chromium permissions the desktop shell grants to the local Searchable UI.
 * Video `<video controls>` fullscreen needs `fullscreen`; voice notes need `media`.
 */
function isLocalAppOrigin(urlOrOrigin, serverPort) {
  try {
    const raw = String(urlOrOrigin || '').trim();
    if (!raw) return false;
    const u = raw.includes('://') ? new URL(raw) : new URL(raw, 'http://127.0.0.1');
    const port = Number(serverPort);
    if (!Number.isFinite(port) || port <= 0) return false;
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
    const effective = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    return effective === port;
  } catch {
    return false;
  }
}

/** Permissions the embedded page may use when talking to our own loopback server. */
const LOCAL_APP_PERMISSIONS = new Set(['media', 'fullscreen']);

function shouldAllowPermission(permission, requestingUrlOrOrigin, serverPort) {
  if (!LOCAL_APP_PERMISSIONS.has(String(permission || ''))) return false;
  return isLocalAppOrigin(requestingUrlOrOrigin, serverPort);
}

module.exports = {
  isLocalAppOrigin,
  shouldAllowPermission,
  LOCAL_APP_PERMISSIONS,
};

#!/usr/bin/env bash
# Rebuild better-sqlite3 for a bundled Node binary (desktop app server child).
# Prefer prebuilt binaries — avoids MSVC/Xcode on CI when possible.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${1:-node}"
VERSION="$("$NODE_BIN" -p "process.versions.node")"
PLATFORM="$("$NODE_BIN" -p "process.platform")"
ARCH="$("$NODE_BIN" -p "process.arch")"

echo "Rebuilding better-sqlite3 for Node ${VERSION} (${PLATFORM}/${ARCH}) using ${NODE_BIN}..."

BS3="$ROOT/node_modules/better-sqlite3"
cd "$BS3"

if npx --yes prebuild-install --runtime node --target "$VERSION" --platform "$PLATFORM" --arch "$ARCH"; then
  echo "better-sqlite3 prebuild installed for Node ${VERSION}"
  exit 0
fi

echo "prebuild-install miss — compiling from source..."
cd "$ROOT"
export npm_config_runtime=node
export npm_config_target="$VERSION"
export npm_config_arch="$ARCH"
export npm_config_platform="$PLATFORM"
# Homebrew Python 3.12+ has no stdlib distutils; node-gyp still imports it.
# Prefer macOS /usr/bin/python3 (3.9) which still ships distutils.
if [[ -z "${npm_config_python:-}${PYTHON:-}" ]]; then
  if [[ -x /usr/bin/python3 ]] && /usr/bin/python3 -c 'from distutils.version import StrictVersion' 2>/dev/null; then
    export npm_config_python=/usr/bin/python3
    export PYTHON=/usr/bin/python3
  fi
fi
npm rebuild better-sqlite3 --build-from-source
echo "better-sqlite3 ready for Node ${VERSION}"

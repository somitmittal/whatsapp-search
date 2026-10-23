#!/usr/bin/env bash
# Rebuild better-sqlite3 for a bundled Node binary (desktop app server child).
# Prefer prebuilt binaries — avoids MSVC/Xcode on CI when possible.
#
# Usage:
#   rebuild-sqlite-for-node.sh [path/to/node]
#   rebuild-sqlite-for-node.sh --from-target   # use build/node/target.json (cross-build)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
META="$ROOT/build/node/target.json"
ARG="${1:-}"

VERSION=""
PLATFORM=""
ARCH=""
NODE_BIN=""

read_target_json() {
  if [[ ! -f "$META" ]]; then
    echo "Missing $META — run prepare-node.sh first" >&2
    exit 1
  fi
  VERSION="$(python3 -c 'import json;print(json.load(open("'"$META"'"))["version"])')"
  PLATFORM="$(python3 -c 'import json;print(json.load(open("'"$META"'"))["platform"])')"
  ARCH="$(python3 -c 'import json;print(json.load(open("'"$META"'"))["arch"])')"
  BIN_REL="$(python3 -c 'import json;print(json.load(open("'"$META"'"))["binary"])')"
  NODE_BIN="$ROOT/build/node/${BIN_REL}"
}

if [[ "$ARG" == "--from-target" ]]; then
  read_target_json
elif [[ -n "$ARG" && -f "$ARG" ]]; then
  NODE_BIN="$ARG"
  if "$NODE_BIN" -p "process.versions.node" >/dev/null 2>&1; then
    VERSION="$("$NODE_BIN" -p "process.versions.node")"
    PLATFORM="$("$NODE_BIN" -p "process.platform")"
    ARCH="$("$NODE_BIN" -p "process.arch")"
  else
    echo "Bundled Node cannot run on this host — using $META"
    read_target_json
  fi
else
  NODE_BIN="${ARG:-node}"
  VERSION="$("$NODE_BIN" -p "process.versions.node")"
  PLATFORM="$("$NODE_BIN" -p "process.platform")"
  ARCH="$("$NODE_BIN" -p "process.arch")"
fi

echo "Rebuilding better-sqlite3 for Node ${VERSION} (${PLATFORM}/${ARCH}) using ${NODE_BIN}..."

BS3="$ROOT/node_modules/better-sqlite3"
cd "$BS3"

if npx --yes prebuild-install --runtime node --target "$VERSION" --platform "$PLATFORM" --arch "$ARCH"; then
  echo "better-sqlite3 prebuild installed for Node ${VERSION} (${PLATFORM}/${ARCH})"
  exit 0
fi

HOST_OS="$(uname -s)"
if [[ "$PLATFORM" == "win32" && "$HOST_OS" != MINGW* && "$HOST_OS" != MSYS* && "$HOST_OS" != CYGWIN* ]]; then
  echo "prebuild-install miss for win32 and this host cannot compile Windows native addons." >&2
  echo "Build Windows packages on windows-latest CI (or a Windows machine)." >&2
  exit 1
fi
if [[ "$PLATFORM" == "linux" && "$HOST_OS" != Linux ]]; then
  echo "prebuild-install miss for linux and this host cannot compile Linux native addons." >&2
  exit 1
fi

echo "prebuild-install miss — compiling from source..."
cd "$ROOT"
export npm_config_runtime=node
export npm_config_target="$VERSION"
export npm_config_arch="$ARCH"
export npm_config_platform="$PLATFORM"
if [[ -z "${npm_config_python:-}${PYTHON:-}" ]]; then
  if [[ -x /usr/bin/python3 ]] && /usr/bin/python3 -c 'from distutils.version import StrictVersion' 2>/dev/null; then
    export npm_config_python=/usr/bin/python3
    export PYTHON=/usr/bin/python3
  fi
fi
npm rebuild better-sqlite3 --build-from-source
echo "better-sqlite3 ready for Node ${VERSION}"

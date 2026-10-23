#!/usr/bin/env bash
# Bundle a Node.js binary for the desktop app server child process.
# Usage: prepare-node.sh <darwin-arm64|darwin-x64|win-x64|linux-x64>
set -euo pipefail

PLATFORM="${1:?Usage: prepare-node.sh <darwin-arm64|darwin-x64|win-x64|linux-x64>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/node/bin"
META="$ROOT/build/node/target.json"
VERSION="22.14.0"

case "$PLATFORM" in
  darwin-arm64|darwin-x64|linux-x64|win-x64) ;;
  *) echo "Unsupported platform: $PLATFORM" >&2; exit 1 ;;
esac

NODE_NAME=node
NODE_PLATFORM=darwin
NODE_ARCH=arm64
case "$PLATFORM" in
  darwin-arm64) NODE_PLATFORM=darwin; NODE_ARCH=arm64 ;;
  darwin-x64) NODE_PLATFORM=darwin; NODE_ARCH=x64 ;;
  linux-x64) NODE_PLATFORM=linux; NODE_ARCH=x64 ;;
  win-x64) NODE_PLATFORM=win32; NODE_ARCH=x64; NODE_NAME=node.exe ;;
esac

mkdir -p "$OUT"
# Drop any previously prepared host/foreign binaries so the package only ships this target.
rm -f "$OUT/node" "$OUT/node.exe"
TARBALL="node-v${VERSION}-${PLATFORM}.tar.gz"
if [ "$PLATFORM" = "win-x64" ]; then
  TARBALL="node-v${VERSION}-${PLATFORM}.zip"
fi

URL="https://nodejs.org/dist/v${VERSION}/${TARBALL}"
TMP="$(mktemp -t "node-${PLATFORM}.XXXXXX")"
if [ "$PLATFORM" = "win-x64" ]; then
  TMP="${TMP}.zip"
else
  TMP="${TMP}.tar.gz"
fi

echo "Downloading Node ${VERSION} for ${PLATFORM}..."
curl -fsSL "$URL" -o "$TMP"

STAGING="$(mktemp -d)"
if [ "$PLATFORM" = "win-x64" ]; then
  unzip -q "$TMP" -d "$STAGING"
  cp "${STAGING}/node-v${VERSION}-${PLATFORM}/${NODE_NAME}" "$OUT/${NODE_NAME}"
else
  tar -xzf "$TMP" -C "$STAGING"
  cp "${STAGING}/node-v${VERSION}-${PLATFORM}/bin/node" "$OUT/node"
  chmod +x "$OUT/node"
fi

rm -rf "$STAGING" "$TMP"

if [[ ! -f "$OUT/${NODE_NAME}" ]]; then
  echo "Expected Node binary missing: $OUT/${NODE_NAME}" >&2
  exit 1
fi

# Record target for rebuild-sqlite (needed when the binary cannot run on this host).
cat > "$META" <<EOF
{
  "version": "${VERSION}",
  "platform": "${NODE_PLATFORM}",
  "arch": "${NODE_ARCH}",
  "preparePlatform": "${PLATFORM}",
  "binary": "bin/${NODE_NAME}"
}
EOF

echo "Node binary ready at $OUT/${NODE_NAME}"

# Only execute native binaries (never run win32 PE on macOS/Linux).
HOST_OS="$(uname -s)"
CAN_RUN=0
case "$PLATFORM" in
  win-x64)
    if [[ "$HOST_OS" == MINGW* || "$HOST_OS" == MSYS* || "$HOST_OS" == CYGWIN* ]]; then
      CAN_RUN=1
    fi
    ;;
  linux-x64)
    if [[ "$HOST_OS" == Linux ]]; then CAN_RUN=1; fi
    ;;
  darwin-*)
    if [[ "$HOST_OS" == Darwin ]]; then CAN_RUN=1; fi
    ;;
esac

if [[ "$CAN_RUN" -eq 1 ]]; then
  "$OUT/${NODE_NAME}" -v
else
  echo "Skipping runtime check — ${NODE_NAME} cannot execute on this host (${HOST_OS}); target recorded in build/node/target.json"
fi

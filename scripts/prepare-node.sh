#!/usr/bin/env bash
# Bundle a Node.js binary for the desktop app server child process.
# Usage: prepare-node.sh <darwin-arm64|darwin-x64|win-x64|linux-x64>
set -euo pipefail

PLATFORM="${1:?Usage: prepare-node.sh <darwin-arm64|darwin-x64|win-x64|linux-x64>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/node/bin"
VERSION="22.14.0"

case "$PLATFORM" in
  darwin-arm64|darwin-x64|linux-x64|win-x64) ;;
  *) echo "Unsupported platform: $PLATFORM" >&2; exit 1 ;;
esac

NODE_NAME=node
if [ "$PLATFORM" = "win-x64" ]; then
  NODE_NAME=node.exe
fi

mkdir -p "$OUT"
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
echo "Node binary ready at $OUT/${NODE_NAME}"
"$OUT/${NODE_NAME}" -v

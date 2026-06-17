#!/usr/bin/env bash
# Bundles a Node.js binary for the Mac desktop app (server child process).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/node/bin"
VERSION="22.14.0"
ARCH="$(uname -m)"

case "$ARCH" in
  arm64) NODE_ARCH="darwin-arm64" ;;
  x86_64) NODE_ARCH="darwin-x64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

mkdir -p "$OUT"
TARBALL="node-v${VERSION}-${NODE_ARCH}.tar.gz"
URL="https://nodejs.org/dist/v${VERSION}/${TARBALL}"
TMP="$(mktemp -t node-mac.XXXXXX.tar.gz)"

echo "Downloading Node ${VERSION} for ${NODE_ARCH}..."
curl -fsSL "$URL" -o "$TMP"

STAGING="$(mktemp -d)"
tar -xzf "$TMP" -C "$STAGING"
cp "${STAGING}/node-v${VERSION}-${NODE_ARCH}/bin/node" "$OUT/node"
chmod +x "$OUT/node"
rm -rf "$STAGING" "$TMP"

echo "Node binary ready at build/node/bin/node"
"$OUT/node" -v

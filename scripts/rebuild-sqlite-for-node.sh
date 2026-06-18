#!/usr/bin/env bash
# Rebuild better-sqlite3 native bindings for a specific Node binary.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${1:-node}"
VERSION="$("$NODE_BIN" -p "process.versions.node")"

echo "Rebuilding better-sqlite3 for Node ${VERSION} (${NODE_BIN})..."
cd "$ROOT"
npm rebuild better-sqlite3 --build-from-source --runtime=node --target="$VERSION"
echo "better-sqlite3 ready for Node ${VERSION}"

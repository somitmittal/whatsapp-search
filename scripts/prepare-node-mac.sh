#!/usr/bin/env bash
set -euo pipefail
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) exec "$(dirname "$0")/prepare-node.sh" darwin-arm64 ;;
  x86_64) exec "$(dirname "$0")/prepare-node.sh" darwin-x64 ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

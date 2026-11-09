#!/usr/bin/env bash
# scripts/init.sh — Deterministic Agent Bootstrap Harness
# (from walkinglabs/learn-harness-engineering Module 06)
#
# Usage:
#   bash scripts/init.sh
#   source scripts/init.sh   # (exports PATH if node@22 needed)

set -eo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "=========================================================="
echo " [Harness Bootstrap] Initializing workspace environment..."
echo " Location: $REPO_DIR"
echo "=========================================================="

# 1. Node.js version resolution (engines requirement: >=22.23.4 <23)
NODE_CMD="node"
CURRENT_NODE_VER="$($NODE_CMD -v 2>/dev/null || echo "none")"
MAJOR_VER="${CURRENT_NODE_VER%%.*}"
MAJOR_VER="${MAJOR_VER#v}"

if [[ "$MAJOR_VER" != "22" ]]; then
  echo "[-] Current Node ($CURRENT_NODE_VER) is outside required range >=22.23.4 <23."
  # Check common Homebrew node@22 paths on macOS
  if [[ -x "/opt/homebrew/opt/node@22/bin/node" ]]; then
    export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
    echo "[+] Activated /opt/homebrew/opt/node@22/bin/node ($(node -v))"
  elif [[ -x "/usr/local/opt/node@22/bin/node" ]]; then
    export PATH="/usr/local/opt/node@22/bin:$PATH"
    echo "[+] Activated /usr/local/opt/node@22/bin/node ($(node -v))"
  else
    echo "[!] WARNING: Node 22 not found in standard paths. You may see ABI errors with native modules."
  fi
else
  echo "[+] Node version compatible: $CURRENT_NODE_VER"
fi

# 2. Worktree node_modules verification
if [[ ! -d "node_modules" ]]; then
  MAIN_MODULES="$(cd "$REPO_DIR/../.." 2>/dev/null && pwd)/node_modules"
  if [[ -d "$MAIN_MODULES" ]]; then
    echo "[*] Worktree missing node_modules. Symlinking from main checkout ($MAIN_MODULES)..."
    ln -s "$MAIN_MODULES" "$REPO_DIR/node_modules"
  else
    echo "[*] Installing node dependencies..."
    npm ci || npm install
  fi
fi

if [[ -d "node_modules" ]]; then
  echo "[+] node_modules present."
else
  echo "[x] ERROR: node_modules missing and could not be linked." >&2
  exit 1
fi

# 3. Native module ABI sanity check (better-sqlite3)
echo "[*] Verifying better-sqlite3 native bindings..."
if node -e "const db = new (require('better-sqlite3'))(':memory:'); db.close();" 2>/dev/null; then
  echo "[+] better-sqlite3 native module loaded cleanly."
else
  echo "[-] better-sqlite3 ABI mismatch detected for current node ($(node -v)). Rebuilding..."
  npm rebuild better-sqlite3
  echo "[+] Rebuild complete."
fi

# 4. Worktree check
GIT_STATUS="$(git status --porcelain 2>/dev/null || true)"
GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")"
echo "[+] Git branch: $GIT_BRANCH"
if [[ -n "$GIT_STATUS" ]]; then
  echo "[!] Notice: Working tree has modified files:"
  git status --short
else
  echo "[+] Working tree clean."
fi

echo "=========================================================="
echo " [Harness Bootstrap] Environment is ready for agent work!"
echo "=========================================================="

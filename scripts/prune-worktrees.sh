#!/usr/bin/env bash
# scripts/prune-worktrees.sh — Worktree Lifecycle & Hygiene Harness
# (from walkinglabs/learn-harness-engineering Module 10: Clean State & Lifecycle)
#
# Usage:
#   bash scripts/prune-worktrees.sh           # Safe dry-run, reports prunable/merged worktrees
#   bash scripts/prune-worktrees.sh --force   # Prunes dead metadata and cleans merged worktrees

set -eo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

FORCE=false
if [[ "$1" == "--force" ]]; then
  FORCE=true
fi

echo "=========================================================="
echo " [Worktree Hygiene] Auditing active git worktrees..."
echo "=========================================================="

# 1. Run git's internal metadata prune
if $FORCE; then
  echo "[*] Running git worktree prune..."
  git worktree prune --verbose
fi

# 2. Inspect worktrees
PRUNABLE_COUNT=0
MERGED_COUNT=0

while IFS= read -r line; do
  if [[ -z "$line" ]]; then continue; fi
  
  WT_PATH=$(echo "$line" | awk '{print $1}')
  WT_BRANCH=$(echo "$line" | awk '{print $3}' | tr -d '[]')
  
  # Skip main checkout
  if [[ "$WT_BRANCH" == "main" || "$WT_PATH" == "$REPO_DIR" ]]; then
    continue
  fi
  
  # Check if marked prunable
  if echo "$line" | grep -q "prunable"; then
    echo "  [PRUNABLE] $WT_PATH ($WT_BRANCH)"
    PRUNABLE_COUNT=$((PRUNABLE_COUNT + 1))
    continue
  fi
  
  # Check if branch is merged into main
  if git merge-base --is-ancestor "$WT_BRANCH" main 2>/dev/null; then
    echo "  [MERGED INTO MAIN] $WT_PATH ($WT_BRANCH)"
    MERGED_COUNT=$((MERGED_COUNT + 1))
    if $FORCE; then
      echo "    Removing merged worktree $WT_PATH..."
      git worktree remove "$WT_PATH" --force 2>/dev/null || true
    fi
  else
    echo "  [ACTIVE WIP] $WT_PATH ($WT_BRANCH)"
  fi
done < <(git worktree list)

echo ""
echo "Summary:"
echo "  Prunable metadata entries: $PRUNABLE_COUNT"
echo "  Merged feature branches:   $MERGED_COUNT"

if ! $FORCE && (( PRUNABLE_COUNT > 0 || MERGED_COUNT > 0 )); then
  echo ""
  echo "[i] Run with --force to clean up merged worktrees and dead metadata:"
  echo "    bash scripts/prune-worktrees.sh --force"
fi

echo "=========================================================="

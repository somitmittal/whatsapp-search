#!/usr/bin/env bash
# scripts/verify.sh — Three-Layer Termination Gate
# (from walkinglabs/learn-harness-engineering Module 09)
#
# Rules:
# An agent CANNOT mark a task or PR as done without this script exiting 0.
#
# Layer 1: Syntax & Static check (node --check on key files)
# Layer 2: Test Suite (Jest VM modules)
# Layer 3: Architectural Contract Smoke Check (scripts/smoke-contract.mjs)

set -eo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# Ensure Node 22 is active
if [[ -x "/opt/homebrew/opt/node@22/bin/node" ]]; then
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
elif [[ -x "/usr/local/opt/node@22/bin/node" ]]; then
  export PATH="/usr/local/opt/node@22/bin:$PATH"
fi

echo "=========================================================="
echo " [Harness Verification] Three-Layer Termination Gate"
echo " Node: $(node -v) at $(which node)"
echo "=========================================================="

# LAYER 1: Syntax & Static Checks
echo ""
echo "--- [Layer 1/3] Syntax & Static Integrity Check ---"
FILES_TO_CHECK=(
  "src/index.js"
  "src/web/server.js"
  "src/gpt/agent.js"
  "src/gpt/gpt-service.js"
  "src/gpt/context.js"
  "src/gpt/tools.js"
  "src/storage/database.js"
  "electron/main.cjs"
)

for file in "${FILES_TO_CHECK[@]}"; do
  if [[ -f "$file" ]]; then
    node --check "$file"
    echo "  [OK] syntax: $file"
  fi
done
echo "[+] Layer 1 PASSED: All key files parse with zero syntax errors."

# LAYER 2: Automated Test Suite (Jest)
echo ""
echo "--- [Layer 2/3] Automated Test Suite Execution ---"
# Support passing specific test files or running full suite
TEST_ARGS=("${@}")
if [[ ${#TEST_ARGS[@]} -eq 0 ]]; then
  # Default suite for verification
  node --experimental-vm-modules node_modules/.bin/jest --forceExit
else
  node --experimental-vm-modules node_modules/.bin/jest "${TEST_ARGS[@]}" --forceExit
fi
echo "[+] Layer 2 PASSED: Test suite execution succeeded."

# LAYER 3: Architectural Smoke & Contract Gate
echo ""
echo "--- [Layer 3/3] Architectural Smoke & Contract Gate ---"
node scripts/smoke-contract.mjs
echo "[+] Layer 3 PASSED: System contracts verified."

echo ""
echo "=========================================================="
echo " [Harness Verification] ALL 3 LAYERS PASSED!"
echo " Task is verified against regressions and safe to hand off."
echo "=========================================================="

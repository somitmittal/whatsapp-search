#!/usr/bin/env bash
# Pillow for scripts/generate-icon.py — macOS runners block system pip (PEP 668).
set -euo pipefail

if [[ "$(uname -s)" == "Darwin" ]]; then
  python3 -m pip install --break-system-packages pillow
else
  pip install pillow
fi

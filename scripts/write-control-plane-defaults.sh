#!/usr/bin/env bash
# Bake hosted control-plane URL into desktop builds (electron/control-plane.defaults.json).
# Desktop control-plane is paused by default (LICENSE_GATE=0). Electron also ignores a baked
# URL unless DESKTOP_ENABLE_CONTROL_PLANE=1.
# Usage (when re-enabling): CONTROL_PLANE_URL=https://… LICENSE_GATE=1 bash scripts/write-control-plane-defaults.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/electron/control-plane.defaults.json"
URL="${CONTROL_PLANE_URL:-${CONTROL_PLANE_PUBLIC_URL:-}}"
URL="${URL%/}"
# Prefer explicit LICENSE_GATE. Otherwise leave gate off (desktop monetization paused).
if [[ -n "${LICENSE_GATE:-}" ]]; then
  GATE="$LICENSE_GATE"
else
  GATE="0"
fi
if [[ -z "$URL" ]]; then
  echo "[control-plane] CONTROL_PLANE_URL unset — licenseGate=$GATE"
fi
node -e '
const fs = require("fs");
const path = process.argv[1];
const url = String(process.argv[2] || "").trim().replace(/\/$/, "");
const gate = String(process.argv[3] || "0");
fs.writeFileSync(path, JSON.stringify({ controlPlaneUrl: url, licenseGate: gate }, null, 2) + "\n");
console.log("[control-plane] wrote", path, "controlPlaneUrl=" + (url || "(empty)"), "licenseGate=" + gate);
' "$OUT" "$URL" "$GATE"

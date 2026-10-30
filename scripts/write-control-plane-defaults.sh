#!/usr/bin/env bash
# Bake hosted control-plane URL into desktop builds (electron/control-plane.defaults.json).
# Usage (CI): CONTROL_PLANE_URL=https://your-host.onrender.com bash scripts/write-control-plane-defaults.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/electron/control-plane.defaults.json"
URL="${CONTROL_PLANE_URL:-${CONTROL_PLANE_PUBLIC_URL:-}}"
URL="${URL%/}"
# With a hosted URL, gate on by default. With no URL, leave gate off so local GPT works
# without a remote account (LICENSE_GATE env still overrides).
if [[ -n "${LICENSE_GATE:-}" ]]; then
  GATE="$LICENSE_GATE"
elif [[ -n "$URL" ]]; then
  GATE="1"
else
  GATE="0"
fi
if [[ -z "$URL" ]]; then
  echo "[control-plane] CONTROL_PLANE_URL unset — desktop builds will use local control_plane.db only (licenseGate=$GATE)"
fi
node -e '
const fs = require("fs");
const path = process.argv[1];
const url = String(process.argv[2] || "").trim().replace(/\/$/, "");
const gate = String(process.argv[3] || "0");
fs.writeFileSync(path, JSON.stringify({ controlPlaneUrl: url, licenseGate: gate }, null, 2) + "\n");
console.log("[control-plane] wrote", path, "controlPlaneUrl=" + (url || "(empty)"), "licenseGate=" + gate);
' "$OUT" "$URL" "$GATE"

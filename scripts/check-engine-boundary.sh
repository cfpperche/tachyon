#!/usr/bin/env bash
# spec 233 — the engine/UI boundary guard. The ENGINE (Workspace + all managers) must never know VS Code
# exists: only the live root-shell allowlist in check-vscode-import-boundaries may import `vscode`.
# packages/engine and packages/webview-ui have zero tolerance in value and type position. Fail CI if
# anything else does, so the decoupling can't silently regress. See docs/system-design.md.
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/check-vscode-import-boundaries.mjs
node scripts/check-engine-import-closure.mjs

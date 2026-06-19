#!/usr/bin/env bash
# spec 233 — the engine/UI boundary guard. The ENGINE (Workspace + all managers) must never know VS Code
# exists: only the SHELL allowlist below may import `vscode`. Fail CI if anything else does, so the
# decoupling can't silently regress. See docs/system-design.md.
set -euo pipefail
cd "$(dirname "$0")/.."

# The shell: the VS Code activation/UI surface + the host adapter. Everything else under src/ is engine.
SHELL_ALLOW='^src/(extension\.ts|presentation/|webview/|workspace/(VsCodeHost|notify)\.ts)'

offenders="$(grep -rlE 'from "vscode"|import \* as vscode from "vscode"' src --include='*.ts' | grep -vE "$SHELL_ALLOW" || true)"

if [ -n "$offenders" ]; then
  echo "engine-boundary: FAIL — these ENGINE files import 'vscode' (only the shell may):" >&2
  echo "$offenders" | sed 's/^/  /' >&2
  echo "Move the vscode touchpoint behind an EngineHost port (src/workspace/EngineHost.ts), or — if the" >&2
  echo "file is genuinely shell (UI/activation) — add it to the SHELL_ALLOW list in this script." >&2
  exit 1
fi
echo "engine-boundary: OK — no 'vscode' import outside the shell allowlist"

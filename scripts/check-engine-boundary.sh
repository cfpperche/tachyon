#!/usr/bin/env bash
# spec 233 — the engine/UI boundary guard. The ENGINE (Workspace + all managers) must never know VS Code
# exists: only the SHELL allowlist below may import `vscode`. Fail CI if anything else does, so the
# decoupling can't silently regress. See docs/system-design.md.
set -euo pipefail
cd "$(dirname "$0")/.."

# The shell: the VS Code activation/UI surface + the host adapter. Everything else under src/ is engine.
# spec 349 T11: plugins/ui/host.ts is also shell; the pure projection/broker modules stay vscode-free.
#
# SDD 410 Phase D (t-610705) moved the studio panel wiring out of src/webview/ — which is shell — into
# src/cockpit/. The files below are that same panel/host code under a new path: studioRegistry declares
# each studio's adapter + legacy serializer, and each *Domain handler is a webview message handler
# ported from a retired *PanelManager (file dialogs, image import). Their vscode use is UI interaction,
# not engine logic.
#
# They are ENUMERATED, not matched by a `src/cockpit/` prefix, on purpose: the other modules in that
# directory (including route/resolveSection/model/missionVm/taskDetailVm/activityFeed/studioIds) are pure
# logic and must STAY vscode-free. A directory-wide allow would let them acquire a vscode import in
# silence, which is the regression this guard exists to catch.
SHELL_ALLOW='^src/(extension\.ts|presentation/|webview/|plugins/ui/host\.ts|runtimeOps/openRuntimeOps\.ts|workspace/(VsCodeHost|notify|legacyVsCodeSettings)\.ts|cockpit/(studioRegistry|taskStudioDomain|pinStudioDomain|agentStudioDomain)\.ts)'

# Match every way to pull in vscode: static import (either quote style), require, and dynamic import().
VSCODE_IMPORT='from ['"'"'"]vscode['"'"'"]|require\(['"'"'"]vscode['"'"'"]\)|import\(['"'"'"]vscode['"'"'"]\)'
offenders="$(grep -rlE "$VSCODE_IMPORT" src --include='*.ts' | grep -vE "$SHELL_ALLOW" || true)"

if [ -n "$offenders" ]; then
  echo "engine-boundary: FAIL — these ENGINE files import 'vscode' (only the shell may):" >&2
  echo "$offenders" | sed 's/^/  /' >&2
  echo "Move the vscode touchpoint behind an EngineHost port (src/workspace/EngineHost.ts), or — if the" >&2
  echo "file is genuinely shell (UI/activation) — add it to the SHELL_ALLOW list in this script." >&2
  exit 1
fi
echo "engine-boundary: OK — no 'vscode' import outside the shell allowlist"
node scripts/check-engine-import-closure.mjs

#!/usr/bin/env bash
# t-abde96 — Xvfb Extension Development Host dogfood for global Settings recovery.
#
# Uses the same launch class as `scripts/dev-host/cli.sh headless` (real code binary,
# extensionDevelopmentPath, extensionTestsPath, isolated user-data / tmux / settings home).
# Not a package.json script: invoke as
#   bash scripts/dev-host/run-settings-recovery.sh
# or under the lane:
#   node scripts/dev-host/lane.mjs run --owner "$TACHYON_AGENT_NAME" --target worktree -- \
#     bash scripts/dev-host/run-settings-recovery.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

die() { echo "settings-recovery: $*" >&2; exit 1; }
info() { echo "settings-recovery: $*"; }

command -v Xvfb >/dev/null 2>&1 || die "Xvfb required (apt install xvfb)"
command -v node >/dev/null 2>&1 || die "node required"

# Prefer the native Electron ELF from .vscode-test (NOT bin/code — that is a WSL remote-cli sh wrapper).
CODE_BIN="$(node "$REPO/scripts/dev-host/resolve-code.mjs" "$REPO" 2>/dev/null || true)"
if [ -z "$CODE_BIN" ] || [ ! -x "$CODE_BIN" ]; then
  info "no cached Electron — seeding .vscode-test via vscode-test once"
  (cd "$REPO" && npx vscode-test --list-configuration >/dev/null 2>&1) || true
  CODE_BIN="$(node "$REPO/scripts/dev-host/resolve-code.mjs" "$REPO")"
fi
[ -n "$CODE_BIN" ] && [ -x "$CODE_BIN" ] || die "no compatible VS Code Electron binary — run npm run test:integration once"
info "code binary: $CODE_BIN"

info "building dev-channel extension"
(cd "$REPO" && npm run build) || die "build failed"

RUNNER="$REPO/scripts/dev-host/headless-settings-recovery.js"
[ -f "$RUNNER" ] || die "missing $RUNNER"

BASE="${TMPDIR:-/tmp}/tachyon-settings-recovery-$$"
OUT="$BASE/out"
mkdir -p "$OUT" "$BASE/tmux" "$BASE/cache" "$BASE/state" "$BASE/data" "$BASE/ext"

# Stage sample-workspace outside the worktrees base (same reason as .vscode-test.mjs).
WS_SRC="$REPO/test/fixtures/sample-workspace"
[ -d "$WS_SRC" ] || die "missing fixture $WS_SRC"
WS="$BASE/workspace"
rm -rf -- "$WS"
cp -a "$WS_SRC" "$WS"

SHA="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DISP="${TACHYON_SETTINGS_RECOVERY_DISPLAY:-:98}"
ENGINE_RUNTIME="$(command -v node)"

run_launch() {
  local label="$1"
  shift
  local result="$OUT/${label}-result.json"
  local host_log="$OUT/${label}-host.log"
  local udd="$OUT/${label}-udd"
  local settings_home="$OUT/${label}-settings-home"
  rm -rf -- "$udd" "$settings_home"
  mkdir -p "$udd/User" "$settings_home"
  cat >"$udd/User/settings.json" <<'JSON'
{
  "workbench.startupEditor": "none",
  "window.newWindowDimensions": "maximized",
  "workbench.colorTheme": "Default Dark Modern",
  "chat.commandCenter.enabled": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "window.commandCenter": false,
  "workbench.layoutControl.enabled": false,
  "breadcrumbs.enabled": false,
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false
}
JSON

  info "starting Xvfb on $DISP for $label"
  Xvfb "$DISP" -screen 0 1600x1000x24 >/dev/null 2>&1 &
  local xvfb_pid=$!
  sleep 1
  kill -0 "$xvfb_pid" 2>/dev/null || die "Xvfb failed on $DISP"

  info "launching EDH $label (code=$CODE_BIN)"
  # shellcheck disable=SC2086
  env -u ELECTRON_RUN_AS_NODE -u TACHYON_AGENT_BRIDGE_TOKEN -u TACHYON_AGENT_NAME \
    -u TACHYON_BRIDGE_TOKEN -u TACHYON_BRIDGE_URL -u TACHYON_NODE_ID -u TACHYON_NODE_NONCE \
    -u TACHYON_RUN_ID -u TACHYON_WORKSPACE_ROOT -u TACHYON_WORKTREE_ROOT \
    -u TMUX -u TMUX_PANE -u CODEX_HOME -u CODEX_THREAD_ID -u CODEX_CI \
    DISPLAY="$DISP" \
    TMUX_TMPDIR="$BASE/tmux" \
    XDG_CACHE_HOME="$BASE/cache" \
    XDG_STATE_HOME="$BASE/state" \
    XDG_DATA_HOME="$BASE/data" \
    TACHYON_DEV_HOST=1 \
    TACHYON_DEV_HOST_ENGINE_RUNTIME="$ENGINE_RUNTIME" \
    TACHYON_GLOBAL_SETTINGS_HOME="$settings_home" \
    DEV_HOST_RESULT="$result" \
    DEV_HOST_SHA="$SHA" \
    "$CODE_BIN" \
      --extensionDevelopmentPath="$REPO" \
      --extensionTestsPath="$RUNNER" \
      --user-data-dir="$udd" \
      --extensions-dir="$BASE/ext" \
      --skip-welcome \
      --skip-release-notes \
      --disable-workspace-trust \
      --use-inmemory-secretstorage \
      --disable-gpu \
      --disable-updates \
      "$@" >"$host_log" 2>&1 &
  local host_pid=$!

  local timeout_s="${TACHYON_SETTINGS_RECOVERY_TIMEOUT:-180}"
  local start_ts
  start_ts="$(date +%s)"
  while kill -0 "$host_pid" 2>/dev/null; do
    if [ "$(( $(date +%s) - start_ts ))" -ge "$timeout_s" ]; then
      kill "$host_pid" 2>/dev/null || true
      wait "$host_pid" 2>/dev/null || true
      kill "$xvfb_pid" 2>/dev/null || true
      info "host log tail ($label):"
      tail -n 80 "$host_log" 2>/dev/null || true
      die "$label timed out after ${timeout_s}s — see $host_log"
    fi
    sleep 0.5
  done
  local host_ec=0
  wait "$host_pid" || host_ec=$?
  kill "$xvfb_pid" 2>/dev/null || true

  if [ ! -f "$result" ]; then
    info "host exit=$host_ec — no result.json; log tail:"
    tail -n 100 "$host_log" 2>/dev/null || true
    die "$label did not write $result"
  fi

  info "result $label: $result"
  python3 - "$result" "$host_ec" "$host_log" <<'PY'
import json, sys
path, host_ec, host_log = sys.argv[1], int(sys.argv[2]), sys.argv[3]
data = json.load(open(path))
print(json.dumps({
  "ok": data.get("ok"),
  "mode": data.get("mode"),
  "host_exit": host_ec,
  "failed": [a["id"] for a in data.get("asserts", []) if not a.get("ok")],
  "passed": [a["id"] for a in data.get("asserts", []) if a.get("ok")],
  "error": data.get("error"),
}, indent=2))
if not data.get("ok"):
  sys.stderr.write(f"see {path} and {host_log}\n")
  sys.exit(1)
PY
}

# 1) Workspace launch — Agent Pane fail-toward + openGlobalSettings under a real folder.
run_launch "with-workspace" "$WS"

# 2) Empty window — zero folders: command registered + create/open global file.
# VS Code opens an empty window when no path argument is given.
run_launch "empty-window"

info "PASS (SHA $SHA) — reports under $OUT"
echo "$OUT"

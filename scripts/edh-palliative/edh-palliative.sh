#!/usr/bin/env bash
# EDH dogfood lane v1 (promoted in place from the palliative helper).
# Isolates fixture workspace + tmux/cache so concurrent SDD 368 work is not touched.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
CMD="${1:-help}"
shift || true

# Stable base under TMP so we never nest worktrees inside the monorepo or ~/.cache/tachyon used by 368.
BASE="${TACHYON_EDH_PALLIATIVE_BASE:-${TMPDIR:-/tmp}/tachyon-edh-palliative}"
# Optional sticky id so seed/launch/clean share the same fixture in one shell session.
ID="${TACHYON_EDH_PALLIATIVE_ID:-default}"
FIXTURE="${BASE}/${ID}"
WS="${FIXTURE}/workspace"
USER_DATA="${FIXTURE}/.edh-user-data"
EXT_DIR="${FIXTURE}/.edh-extensions"
TMUX_DIR="${FIXTURE}/.tmux"
CACHE_HOME="${FIXTURE}/.cache"
PID_FILE="${FIXTURE}/.edh.pid"
RESOLVE_CODE="$REPO/scripts/edh-palliative/resolve-code.mjs"
STOP_BRIDGE="$REPO/scripts/edh-palliative/stop-bridge.mjs"

# Only the EDH child receives these removals. The caller's shell/session remains untouched.
EDH_ENV=(
  -u ELECTRON_RUN_AS_NODE
  -u TACHYON_AGENT_BRIDGE_TOKEN
  -u TACHYON_AGENT_NAME
  -u TACHYON_BRIDGE_TOKEN
  -u TACHYON_BRIDGE_URL
  -u TACHYON_NODE_ID
  -u TACHYON_NODE_NONCE
  -u TACHYON_RUN_ID
  -u TACHYON_WORKSPACE_ROOT
  -u TACHYON_WORKTREE_ROOT
  -u TMUX
  -u TMUX_PANE
  -u CODEX_HOME
  -u CODEX_THREAD_ID
  -u CODEX_CI
  "TMUX_TMPDIR=$TMUX_DIR"
  "XDG_CACHE_HOME=$CACHE_HOME"
)

die() { echo "edh-palliative: $*" >&2; exit 1; }
info() { echo "edh-palliative: $*"; }

record_edh_pid() {
  local pid="$1"
  local temporary="${PID_FILE}.${pid}.tmp"
  (umask 077; printf '%s\n' "$pid" >"$temporary")
  mv -f -- "$temporary" "$PID_FILE"
}

stop_private_tmux() {
  local socket="${TMUX_DIR}/tmux-$(id -u)/tachyon"
  [ ! -L "$socket" ] || die "refusing symlinked fixture tmux socket"
  if [ -e "$socket" ] && [ ! -S "$socket" ]; then
    die "refusing non-socket fixture tmux path"
  fi
  [ -S "$socket" ] || return 0
  command -v tmux >/dev/null 2>&1 || die "fixture tmux is running but tmux is unavailable for cleanup"
  env -u TMUX -u TMUX_PANE TMUX_TMPDIR="$TMUX_DIR" tmux -L tachyon kill-server \
    || die "failed to stop fixture-private tmux server"
  local attempt
  for attempt in 1 2 3 4 5; do
    [ ! -e "$socket" ] && return 0
    if ! env -u TMUX -u TMUX_PANE TMUX_TMPDIR="$TMUX_DIR" tmux -L tachyon list-sessions >/dev/null 2>&1; then
      rm -f -- "$socket"
      [ ! -e "$socket" ] && return 0
      die "failed to remove stopped fixture-private tmux socket"
    fi
    sleep 0.05
  done
  die "fixture-private tmux server remained responsive after kill-server"
}

write_valid_config() {
  # kind: agent is explicit — bare `echo` would infer terminal and reject subagents.
  cat >"$WS/tachyon.yml" <<'YAML'
# EDH palliative fixture — NOT the monorepo fleet.
# Safe to break for fail-visible dogfood (S1 in docs/runbooks/edh-palliative-dogfood.md).
agents:
  pilot:
    cmd: echo pilot-agent
    kind: agent
    autostart: false
    subagents: [reviewer]
  reviewer:
    cmd: echo reviewer-agent
    kind: agent
    autostart: false
commands:
  hello:
    cmd: "echo edh-palliative-ok"
YAML
}

write_broken_config() {
  # Hard parse failure (t-099be8 made *dangling* subagents a warning, not fatal).
  # Self-reference still fails closed — same class of "config invalid → no roster wipe" dogfood.
  cat >"$WS/tachyon.yml" <<'YAML'
# BROKEN on purpose for t-8354ae dogfood — hard validation error.
agents:
  pilot:
    cmd: echo pilot-agent
    kind: agent
    autostart: false
    subagents: [pilot]
YAML
}

write_lkg_and_ledger() {
  mkdir -p "$WS/.tachyon"
  # Last-known-good roster (machine-local shape used by t-8354ae).
  cat >"$WS/.tachyon/config.lkg.json" <<'JSON'
{
  "schemaVersion": 1,
  "savedAt": "2026-07-10T15:00:00.000Z",
  "sourceFile": "tachyon.yml",
  "agents": [
    { "name": "pilot", "kind": "agent", "cmd": "echo pilot-agent" },
    { "name": "reviewer", "kind": "agent", "cmd": "echo reviewer-agent", "declaredOwner": "pilot" }
  ]
}
JSON
  # note: kind agent in LKG matches seed tachyon.yml (kind: agent on both entries)

  # Minimal session ledger so degraded roster has a resumable-ish declared row (resume may still
  # fail without a real runtime transcript — the row must still RENDER).
  cat >"$WS/.tachyon/sessions.json" <<'JSON'
{
  "sessions": {
    "pilot": {
      "cwd": "WORKSPACE_PLACEHOLDER",
      "declared": true,
      "updatedAt": "2026-07-10T15:30:00.000Z",
      "def": {
        "cmd": "echo pilot-agent",
        "kind": "agent"
      }
    },
    "reviewer": {
      "cwd": "WORKSPACE_PLACEHOLDER",
      "declared": true,
      "updatedAt": "2026-07-10T15:30:00.000Z",
      "def": {
        "cmd": "echo reviewer-agent",
        "kind": "agent",
        "parent": "pilot"
      }
    }
  }
}
JSON
  # Fix cwd placeholders to the real workspace path.
  python3 - "$WS" <<'PY'
import json, pathlib, sys
ws = pathlib.Path(sys.argv[1])
p = ws / ".tachyon" / "sessions.json"
data = json.loads(p.read_text())
for rec in data.get("sessions", {}).values():
    rec["cwd"] = str(ws)
p.write_text(json.dumps(data, indent=2) + "\n")
PY
}

seed() {
  mkdir -p "$WS" "$USER_DATA" "$EXT_DIR" "$TMUX_DIR" "$CACHE_HOME"
  chmod 700 "$FIXTURE" "$WS" "$USER_DATA" "$EXT_DIR" "$TMUX_DIR" "$CACHE_HOME"
  write_valid_config
  write_lkg_and_ledger
  cat >"$WS/README.md" <<EOF
# EDH palliative fixture

Isolated dogfood workspace. Do **not** open the monorepo root for this scenario.

- Runbook: \`docs/runbooks/edh-palliative-dogfood.md\`
- Break config: \`npm run dogfood:edh-palliative -- break\` (from monorepo)
- Restore config: \`npm run dogfood:edh-palliative -- restore\`
- Fixture id: \`${ID}\`
- Created: $(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  info "seeded fixture at $FIXTURE"
  info "workspace: $WS"
  print_launch_hint
}

break_config() {
  [ -d "$WS" ] || die "no fixture — run: npm run dogfood:edh-palliative -- seed"
  write_broken_config
  info "wrote BROKEN tachyon.yml (dangling subagents: [ghost])"
  info "In EDH only: Developer: Reload Window → expect fail-visible banner + degraded roster"
}

restore_config() {
  [ -d "$WS" ] || die "no fixture — run seed first"
  write_valid_config
  info "restored valid tachyon.yml"
}

print_launch_hint() {
  cat <<EOF

--- launch (copy/paste) ---
# Resolve with the lane command; remote-cli/code is refused.
TACHYON_EDH_CODE="\$(node '$RESOLVE_CODE' '$REPO')"
# Use the resolved native/test binary; never kill the default tmux server.
env -u ELECTRON_RUN_AS_NODE -u TACHYON_AGENT_BRIDGE_TOKEN -u TACHYON_AGENT_NAME \\
  -u TACHYON_BRIDGE_TOKEN -u TACHYON_BRIDGE_URL -u TMUX -u TMUX_PANE \\
  -u TACHYON_NODE_ID -u TACHYON_NODE_NONCE -u TACHYON_RUN_ID \\
  -u TACHYON_WORKSPACE_ROOT -u TACHYON_WORKTREE_ROOT \\
  -u CODEX_HOME -u CODEX_THREAD_ID -u CODEX_CI \\
  TMUX_TMPDIR='$TMUX_DIR' XDG_CACHE_HOME='$CACHE_HOME' \\
  "\$TACHYON_EDH_CODE" \\
  --extensionDevelopmentPath='$REPO' \\
  --user-data-dir='$USER_DATA' \\
  --extensions-dir='$EXT_DIR' \\
  --disable-workspace-trust \\
  --use-inmemory-secretstorage \\
  '$WS'
---------------------------
Record SHA: $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)
Runbook:    docs/runbooks/edh-palliative-dogfood.md
Scenario:   S1 fail-visible → npm run dogfood:edh-palliative -- break

EOF
}

find_code() {
  node "$RESOLVE_CODE" "$REPO"
}

launch() {
  [ -d "$WS" ] || seed
  # Ensure extension is built (dist/extension.js is the usual entry).
  if [ ! -f "$REPO/dist/extension.js" ]; then
    info "dist/ missing — running npm run build"
    (cd "$REPO" && npm run build)
  fi
  local code_bin
  if ! code_bin="$(find_code)"; then
    die "refusing EDH launch without a compatible VS Code executable"
  fi
  info "launching EDH with $code_bin"
  info "isolation: TMUX_TMPDIR=$TMUX_DIR XDG_CACHE_HOME=$CACHE_HOME"
  # Background: return control to the caller (Codex/368 stays untouched).
  if [ "${TACHYON_EDH_FOREGROUND:-}" = "1" ]; then
    record_edh_pid "$$"
    exec env "${EDH_ENV[@]}" "$code_bin" \
      --extensionDevelopmentPath="$REPO" \
      --user-data-dir="$USER_DATA" \
      --extensions-dir="$EXT_DIR" \
      --disable-workspace-trust \
      --use-inmemory-secretstorage \
      "$WS"
  fi
  env "${EDH_ENV[@]}" "$code_bin" \
    --extensionDevelopmentPath="$REPO" \
    --user-data-dir="$USER_DATA" \
    --extensions-dir="$EXT_DIR" \
    --disable-workspace-trust \
    --use-inmemory-secretstorage \
    "$WS" >/dev/null 2>&1 &
  local edh_pid=$!
  record_edh_pid "$edh_pid"
  info "EDH started (pid $edh_pid). Drive the window; do not reload the normal Codex window."
  print_launch_hint
}

clean() {
  if [ -d "$FIXTURE" ]; then
    node "$STOP_BRIDGE" "$FIXTURE" || die "refusing fixture removal while its persistent Bridge may still be running"
    stop_private_tmux
    rm -rf -- "$FIXTURE"
    info "removed $FIXTURE"
  else
    info "nothing to clean at $FIXTURE"
  fi
}

status() {
  if [ -d "$WS" ]; then
    info "fixture: $FIXTURE"
    info "config:  $([ -f "$WS/tachyon.yml" ] && echo present || echo missing)"
    if [ -f "$WS/tachyon.yml" ] && grep -q 'subagents: \[pilot\]' "$WS/tachyon.yml" 2>/dev/null; then
      info "state:   BROKEN (fail-visible scenario armed)"
    else
      info "state:   valid (or unknown)"
    fi
    info "SHA:     $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  else
    info "no fixture — run seed"
  fi
}

headless() {
  # Real Extension Development Host on Xvfb — no GUI wizard, no agent-desktop.
  # Fixture is seeded + broken before launch so start() sees invalid config (cold path).
  command -v Xvfb >/dev/null 2>&1 || die "Xvfb required for headless (apt install xvfb)"
  local code_bin
  if ! code_bin="$(find_code)"; then
    die "no compatible VS Code executable — run npm run test:integration once, or set TACHYON_EDH_CODE"
  fi
  if [ ! -f "$REPO/dist/extension.js" ]; then
    info "dist/ missing — running npm run build"
    (cd "$REPO" && npm run build) || die "build failed"
  fi

  seed
  write_broken_config
  info "armed BROKEN config for cold-start fail-visible"

  local out_dir="${FIXTURE}/headless-out"
  local result="${out_dir}/result.json"
  local host_log="${out_dir}/host.log"
  local shot_dir="${out_dir}/shots"
  local udd="${out_dir}/udd"
  rm -rf -- "$out_dir"
  mkdir -p "$udd/User" "$TMUX_DIR" "$CACHE_HOME" "$shot_dir"
  command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg required for headless screenshots"
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

  local disp="${TACHYON_EDH_DISPLAY:-:96}"
  local sha
  sha="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  local runner="$REPO/scripts/edh-palliative/headless-runner.js"
  [ -f "$runner" ] || die "missing $runner"

  info "starting Xvfb on $disp"
  Xvfb "$disp" -screen 0 1600x1000x24 >/dev/null 2>&1 &
  local xvfb_pid=$!
  # shellcheck disable=SC2064
  trap "kill $xvfb_pid 2>/dev/null || true" EXIT
  sleep 1
  kill -0 "$xvfb_pid" 2>/dev/null || die "Xvfb failed to start on $disp"

  info "launching headless EDH (code=$code_bin)"
  env "${EDH_ENV[@]}" \
    DISPLAY="$disp" \
    EDH_PALLIATIVE_RESULT="$result" \
    EDH_PALLIATIVE_WS="$WS" \
    EDH_PALLIATIVE_SHA="$sha" \
    EDH_PALLIATIVE_SHOTDIR="$shot_dir" \
    "$code_bin" \
      --extensionDevelopmentPath="$REPO" \
      --extensionTestsPath="$runner" \
      --user-data-dir="$udd" \
      --extensions-dir="$EXT_DIR" \
      --skip-welcome \
      --skip-release-notes \
      --disable-workspace-trust \
      --use-inmemory-secretstorage \
      --disable-gpu \
      --disable-updates \
      "$WS" >"$host_log" 2>&1 &
  local host_pid=$!

  # While the host is up, grab Xvfb frames for each ready-* marker (capture.sh pattern).
  local timeout_s="${TACHYON_EDH_HEADLESS_TIMEOUT:-120}"
  local start_ts
  start_ts="$(date +%s)"
  while kill -0 "$host_pid" 2>/dev/null; do
    for r in "$shot_dir"/ready-*; do
      [ -e "$r" ] || continue
      name="$(basename "$r" | sed 's/^ready-//')"
      [ -e "$shot_dir/done-$name" ] && continue
      sleep 0.8
      if DISPLAY="$disp" ffmpeg -hide_banner -loglevel error -y \
        -f x11grab -video_size 1600x1000 -i "$disp" -frames:v 1 \
        "$shot_dir/${name}.png" 2>>"$host_log"; then
        touch "$shot_dir/done-$name"
        info "captured shot: $shot_dir/${name}.png"
      else
        info "ffmpeg frame failed for $name (see host.log)"
        # Still mark done so the runner does not hang forever.
        touch "$shot_dir/done-$name"
      fi
    done
    if [ "$(( $(date +%s) - start_ts ))" -ge "$timeout_s" ]; then
      kill "$host_pid" 2>/dev/null || true
      wait "$host_pid" 2>/dev/null || true
      info "host log (tail):"
      tail -n 80 "$host_log" 2>/dev/null || true
      die "headless timed out after ${timeout_s}s — see $host_log"
    fi
    sleep 0.5
  done
  local host_ec=0
  wait "$host_pid" || host_ec=$?

  kill "$xvfb_pid" 2>/dev/null || true
  trap - EXIT

  if [ ! -f "$result" ]; then
    info "host exit=$host_ec — no result.json; host log tail:"
    tail -n 100 "$host_log" 2>/dev/null || true
    die "headless runner did not write $result"
  fi

  # Copy PNGs into repo evidence (gitignored under .tachyon/) for local inspection.
  local evidence_dir="$REPO/.tachyon/evidence/edh-palliative"
  mkdir -p "$evidence_dir"
  for png in "$shot_dir"/*.png; do
    [ -f "$png" ] || continue
    cp -f "$png" "$evidence_dir/"
    info "evidence: $evidence_dir/$(basename "$png")"
  done

  info "result: $result"
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$result" "$host_ec" "$shot_dir" <<'PY'
import json, sys, os
path, host_ec, shot_dir = sys.argv[1], int(sys.argv[2]), sys.argv[3]
data = json.load(open(path))
shots = [f for f in os.listdir(shot_dir) if f.endswith(".png")] if os.path.isdir(shot_dir) else []
print(json.dumps({
  "ok": data.get("ok"),
  "host_exit": host_ec,
  "failed": [a["id"] for a in data.get("asserts", []) if not a.get("ok")],
  "passed": [a["id"] for a in data.get("asserts", []) if a.get("ok")],
  "error": data.get("error"),
  "roster": (data.get("health") or {}).get("rosterNames"),
  "lkgSpawn": (data.get("health") or {}).get("lkgSpawn"),
  "frames": data.get("frames"),
  "shots": shots,
}, indent=2))
sys.exit(0 if data.get("ok") else 1)
PY
    local py_ec=$?
    if [ "$py_ec" -ne 0 ]; then
      info "host log (tail):"
      tail -n 60 "$host_log" 2>/dev/null || true
      die "headless asserts failed — full report: $result"
    fi
  else
    # Fallback: require host success + result contains "ok": true
    if ! grep -q '"ok": true' "$result"; then
      die "headless failed — see $result and $host_log"
    fi
  fi
  info "headless PASS (SHA $sha) — report $result — shots $shot_dir"
}

shortlist() {
  # Headless Chromium captures of top UI surfaces missing visual evidence
  # (mermaid Activity, Grok Activity feed, Handoff Distill targets).
  # Extra args after shortlist are scene names; default = the three.
  bash "$REPO/scripts/edh-palliative/run-shortlist.sh" "$@"
}

help() {
  cat <<'EOF'
Usage: npm run dogfood:edh -- <command>

Commands:
  seed      Create isolated fixture (valid config + LKG + ledger)
  break     Arm t-8354ae fail-visible scenario (dangling subagent)
  restore   Restore valid tachyon.yml in the fixture
  launch    Open GUI Extension Development Host (interactive)
  resolve-code Print the compatible VS Code executable selected for EDH
  headless  Xvfb EDH + in-host runner (S1 fail-visible asserts)
  shortlist Headless Chromium screenshots: mermaid | grok-activity | handoff-distill
            (default: all three). Pass scene names to subset.
  status    Show fixture path / broken-or-valid
  clean     Delete the fixture directory
  lease ... Atomic owner lease (acquire|release|status|run); see runbook
  help      This text

Examples:
  npm run dogfood:edh-palliative -- shortlist
  npm run dogfood:edh-palliative -- shortlist mermaid handoff-distill
  npm run dogfood:edh-palliative -- shortlist fail-visible   # also runs EDH S1

Env:
  TACHYON_EDH_PALLIATIVE_ID   fixture id (default: default)
  TACHYON_EDH_PALLIATIVE_BASE parent dir (default: $TMPDIR/tachyon-edh-palliative)
  TACHYON_EDH_CODE            path to VS Code / test binary
  TACHYON_EDH_DISPLAY         Xvfb display (default: :96)
  TACHYON_EDH_HEADLESS_TIMEOUT  seconds (default: 120)
  TACHYON_EDH_FOREGROUND=1    launch (GUI) in foreground (exec)
  TACHYON_SHORTLIST_OUT       evidence root (default .tachyon/evidence/ui-shortlist)
  TACHYON_CHROME              Chrome/Chromium binary for preview shots

See docs/runbooks/edh-palliative-dogfood.md (EDH lane v1)
EOF
}

case "$CMD" in
  lease) node "$REPO/scripts/edh-palliative/lane.mjs" "${@:-status}" ;;
  seed) seed ;;
  break) break_config ;;
  restore) restore_config ;;
  launch) launch ;;
  resolve-code) find_code ;;
  headless) headless ;;
  shortlist) shortlist "$@" ;;
  status) status ;;
  clean) clean ;;
  help|-h|--help) help ;;
  *) die "unknown command '$CMD' (try help)" ;;
esac

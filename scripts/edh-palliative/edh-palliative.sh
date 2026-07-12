#!/usr/bin/env bash
# EDH palliative dogfood helper (stopgap until t-1d53e8).
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

die() { echo "edh-palliative: $*" >&2; exit 1; }
info() { echo "edh-palliative: $*"; }

write_valid_config() {
  cat >"$WS/tachyon.yml" <<'YAML'
# EDH palliative fixture — NOT the monorepo fleet.
# Safe to break for fail-visible dogfood (S1 in docs/runbooks/edh-palliative-dogfood.md).
agents:
  pilot:
    cmd: echo pilot-agent
    autostart: false
    subagents: [reviewer]
  reviewer:
    cmd: echo reviewer-agent
    autostart: false
commands:
  hello:
    cmd: "echo edh-palliative-ok"
YAML
}

write_broken_config() {
  # Incident-shaped: dangling subagent reference (loadConfig rejects whole file).
  cat >"$WS/tachyon.yml" <<'YAML'
# BROKEN on purpose for t-8354ae dogfood — dangling subagent.
agents:
  pilot:
    cmd: echo pilot-agent
    autostart: false
    subagents: [ghost]
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
export TMUX_TMPDIR='$TMUX_DIR'
export XDG_CACHE_HOME='$CACHE_HOME'
# Prefer VS Code test binary or 'code' on PATH — never kill the default tmux server.
code \\
  --extensionDevelopmentPath='$REPO' \\
  --user-data-dir='$USER_DATA' \\
  --extensions-dir='$EXT_DIR' \\
  --disable-workspace-trust \\
  '$WS'
---------------------------
Record SHA: $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)
Runbook:    docs/runbooks/edh-palliative-dogfood.md
Scenario:   S1 fail-visible → npm run dogfood:edh-palliative -- break

EOF
}

find_code() {
  if [ -n "${TACHYON_EDH_CODE:-}" ] && [ -x "${TACHYON_EDH_CODE}" ]; then
    echo "$TACHYON_EDH_CODE"
    return
  fi
  local test_bin
  test_bin="$(ls -d "$REPO"/.vscode-test/vscode-linux-*/code 2>/dev/null | head -1 || true)"
  if [ -n "$test_bin" ] && [ -x "$test_bin" ]; then
    echo "$test_bin"
    return
  fi
  if command -v code >/dev/null 2>&1; then
    command -v code
    return
  fi
  return 1
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
    info "no code binary found — seed is ready; launch manually:"
    print_launch_hint
    exit 0
  fi
  info "launching EDH with $code_bin"
  info "isolation: TMUX_TMPDIR=$TMUX_DIR XDG_CACHE_HOME=$CACHE_HOME"
  # Do not share the live editor's Electron as node.
  unset ELECTRON_RUN_AS_NODE || true
  export TMUX_TMPDIR="$TMUX_DIR"
  export XDG_CACHE_HOME="$CACHE_HOME"
  # Background: return control to the caller (Codex/368 stays untouched).
  if [ "${TACHYON_EDH_FOREGROUND:-}" = "1" ]; then
    exec "$code_bin" \
      --extensionDevelopmentPath="$REPO" \
      --user-data-dir="$USER_DATA" \
      --extensions-dir="$EXT_DIR" \
      --disable-workspace-trust \
      "$WS"
  fi
  "$code_bin" \
    --extensionDevelopmentPath="$REPO" \
    --user-data-dir="$USER_DATA" \
    --extensions-dir="$EXT_DIR" \
    --disable-workspace-trust \
    "$WS" >/dev/null 2>&1 &
  info "EDH started (pid $!). Drive the window; do not reload the normal Codex window."
  print_launch_hint
}

clean() {
  if [ -d "$FIXTURE" ]; then
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
    if [ -f "$WS/tachyon.yml" ] && grep -q 'ghost' "$WS/tachyon.yml" 2>/dev/null; then
      info "state:   BROKEN (fail-visible scenario armed)"
    else
      info "state:   valid (or unknown)"
    fi
    info "SHA:     $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  else
    info "no fixture — run seed"
  fi
}

help() {
  cat <<'EOF'
Usage: npm run dogfood:edh-palliative -- <command>

Commands:
  seed      Create isolated fixture (valid config + LKG + ledger)
  break     Arm t-8354ae fail-visible scenario (dangling subagent)
  restore   Restore valid tachyon.yml in the fixture
  launch    Open Extension Development Host on the fixture (isolated)
  status    Show fixture path / broken-or-valid
  clean     Delete the fixture directory
  help      This text

Env:
  TACHYON_EDH_PALLIATIVE_ID   fixture id (default: default)
  TACHYON_EDH_PALLIATIVE_BASE parent dir (default: $TMPDIR/tachyon-edh-palliative)
  TACHYON_EDH_CODE            path to VS Code / test binary
  TACHYON_EDH_FOREGROUND=1    launch in foreground (exec)

See docs/runbooks/edh-palliative-dogfood.md
EOF
}

case "$CMD" in
  seed) seed ;;
  break) break_config ;;
  restore) restore_config ;;
  launch) launch ;;
  status) status ;;
  clean) clean ;;
  help|-h|--help) help ;;
  *) die "unknown command '$CMD' (try help)" ;;
esac

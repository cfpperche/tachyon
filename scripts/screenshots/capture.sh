#!/usr/bin/env bash
# Reproduce the README/landing screenshots by driving the real extension in a
# headless VSCode host (Xvfb) and grabbing frames with ffmpeg. Captures live
# from the committed examples — no mockups.
#
# Requirements: tmux, xvfb, ffmpeg, and the VSCode test binary
#   (downloaded once by `npm run test:integration`).
# Examples need their deps:  (cd examples/orbit-api && npm install)
#
# Usage:   scripts/screenshots/capture.sh <scene> [workspace]
#   scene:     hero | observability | lineage | studio | multiroot | inspector | commands | pins | schedules | walkthrough
#   workspace: defaults to examples/orbit-api (multiroot -> examples/orbit.code-workspace)
#
# Frames land in scripts/screenshots/out/*.png at 1600x1000; crop with crop.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO="$PWD"

# The VSCode test binary is the Electron app — but if ELECTRON_RUN_AS_NODE is set
# in the environment (e.g. some agent/CLI runtimes set it), the binary runs as
# Node and rejects every VSCode flag ("bad option: --version"). @vscode/test-electron
# unsets it internally; the rig launches the binary directly, so we must too.
unset ELECTRON_RUN_AS_NODE

# The demo workspace is the STANDALONE tachyon-examples repo (its own git repo, so
# worktree scenes work — unlike examples/ nested in this repo). Auto-clone it if
# absent so the rig stays self-bootstrapping; override the location with $TACHYON_EXAMPLES.
EXAMPLES="${TACHYON_EXAMPLES:-$HOME/tachyon-examples}"
if [ ! -d "$EXAMPLES/.git" ]; then
  echo "tachyon-examples not found at $EXAMPLES — cloning…"
  git clone https://github.com/cfpperche/tachyon-examples "$EXAMPLES"
fi
[ -d "$EXAMPLES/node_modules" ] || (cd "$EXAMPLES" && npm install >/dev/null 2>&1) || true

# spec 224 — screencast mode: `capture.sh --record <scene> [secs]` records the Xvfb display to mp4
# while the runner choreographs a timed scene, instead of grabbing one frame per marker.
RECORD=0; SECS=25
if [ "${1:-}" = "--record" ]; then RECORD=1; shift; fi
SCENE="${1:?scene required}"
if [ "$RECORD" = 1 ]; then SECS="${2:-25}"; WS=""; else WS="${2:-}"; fi
if [ -z "$WS" ]; then
  if [ "$SCENE" = multiroot ]; then WS="$EXAMPLES/orbit.code-workspace"; else WS="$EXAMPLES"; fi
fi

# Isolate each scene. The capture host gets a PRIVATE tmux namespace
# (TMUX_TMPDIR) so the rig never shares the "tachyon" socket with a live
# editor/EDH on this machine — a shared socket meant kill-server nuked the
# user's real agents, and a wedged client left by another host broke every
# capture with "server exited unexpectedly". The extension and runner.js both
# inherit this env from the host process. Example writable state (pins /
# pending proposals) is wiped so a scene's sidebar reflects only what it sets
# up — without this, lower tree sections shift and crops drift.
export TMUX_TMPDIR="$REPO/scripts/screenshots/out/tmux"
rm -rf -- "$TMUX_TMPDIR"; mkdir -p "$TMUX_TMPDIR"
# Isolate + RESET the worktree cache per run: worktree/verify scenes must fork fresh
# from the current HEAD (a reused stale worktree mis-reports verify), and the rig must
# never touch the user's real ~/.cache/tachyon/worktrees. resolveBase honors XDG_CACHE_HOME.
# MUST live OUTSIDE this repo — a worktree nested under tachyon/ would inherit tachyon's own
# vitest/tsconfig (vitest walks up), breaking the demo's `npm test` (verify gate).
export XDG_CACHE_HOME="${TMPDIR:-/tmp}/tachyon-rig-cache"
rm -rf -- "$XDG_CACHE_HOME/tachyon/worktrees"; mkdir -p "$XDG_CACHE_HOME"
# Force-remove ANY leftover worktree of the demo repo (a stale one from a prior run, anywhere,
# holds tachyon/feature checked out → a fresh worktree add fails as "checked-out-elsewhere").
git -C "$EXAMPLES" worktree list --porcelain 2>/dev/null \
  | awk '/^worktree /{p=$2} /^branch /{b=$2} /^$/{if(p && b !~ /\/main$/) print p; p="";b=""}' \
  | while read -r wtp; do [ "$wtp" = "$EXAMPLES" ] || git -C "$EXAMPLES" worktree remove --force "$wtp" 2>/dev/null || true; done
git -C "$EXAMPLES" worktree prune 2>/dev/null || true
git -C "$EXAMPLES" branch -D tachyon/feature 2>/dev/null || true
rm -f "$EXAMPLES"/.tachyon/pins.json "$EXAMPLES"/.tachyon/schedules-pending.json "$EXAMPLES"/.tachyon/sessions.json \
  "$EXAMPLES"/*/.tachyon/pins.json "$EXAMPLES"/*/.tachyon/schedules-pending.json "$EXAMPLES"/*/.tachyon/sessions.json 2>/dev/null || true
# also clear any leftover worktrees a prior worktree/verify scene created (so the
# feature agent forks cleanly each run) — best-effort.
git -C "$EXAMPLES" worktree prune 2>/dev/null || true
# sessions.json too: a stale resume ledger makes autostart try `--resume <id>`
# for a session that no longer exists -> the agent crashes (exit 1) instead of
# showing "running".

SHOTDIR="$REPO/scripts/screenshots/out"; mkdir -p "$SHOTDIR"
CODE="$(ls -d "$REPO"/.vscode-test/vscode-linux-*/code 2>/dev/null | head -1)"
[ -x "$CODE" ] || { echo "VSCode test binary missing — run 'npm run test:integration' once first." >&2; exit 1; }
DISP=":97"; UDD="$SHOTDIR/udd"
rm -rf -- "$UDD"; mkdir -p "$UDD/User"
cat > "$UDD/User/settings.json" <<JSON
{ "workbench.startupEditor":"none","window.newWindowDimensions":"maximized","workbench.colorTheme":"Default Dark Modern","chat.commandCenter.enabled":false,"update.mode":"none","telemetry.telemetryLevel":"off","window.commandCenter":false,"workbench.layoutControl.enabled":false,"breadcrumbs.enabled":false }
JSON

rm -f "$SHOTDIR"/ready-* "$SHOTDIR"/done-* "$SHOTDIR"/go-cast 2>/dev/null || true
Xvfb "$DISP" -screen 0 1600x1000x24 >/dev/null 2>&1 & XVFB=$!
# Clean up BOTH the VSCode host and Xvfb on any exit (incl. an ffmpeg failure under set -e) so a
# record run never leaks the host process (review fix).
trap 'kill ${HOST:-} ${XVFB:-} 2>/dev/null || true' EXIT
sleep 2
SHOTDIR="$SHOTDIR" SCENE="$SCENE" CAST_SECS="$SECS" DISPLAY="$DISP" \
  "$CODE" --extensionDevelopmentPath="$REPO" --extensionTestsPath="$REPO/scripts/screenshots/runner.js" \
  --user-data-dir "$UDD" --skip-welcome --skip-release-notes --disable-workspace-trust --disable-gpu \
  "$WS" >"$SHOTDIR/host.log" 2>&1 & HOST=$!

if [ "$RECORD" = 1 ]; then
  # Screencast (spec 224): wait until the scene set up + raised `ready-cast`, then record the Xvfb
  # display for SECS while the runner runs its timed beats. `go-cast` tells the runner ffmpeg is
  # rolling, so the beats and the recording start together (no boot skew).
  for _ in $(seq 1 240); do [ -e "$SHOTDIR/ready-cast" ] && break; kill -0 $HOST 2>/dev/null || break; sleep 0.5; done
  # Don't record a bogus asset if the scene never signalled it was set up (setup failed / host exited).
  if [ ! -e "$SHOTDIR/ready-cast" ]; then
    echo "scene '$SCENE' never reached ready-cast (setup failed or host exited) — NOT recording. See $SHOTDIR/host.log" >&2
    exit 1
  fi
  DISPLAY="$DISP" ffmpeg -hide_banner -loglevel error -y -f x11grab -framerate 30 -video_size 1600x1000 -i "$DISP" \
    -t "$SECS" -c:v libx264 -pix_fmt yuv420p -preset veryfast "$SHOTDIR/$SCENE.mp4" & FF=$!
  sleep 0.3; touch "$SHOTDIR/go-cast"
  wait "$FF" || echo "ffmpeg exited non-zero — check $SHOTDIR/$SCENE.mp4" >&2
  kill $HOST 2>/dev/null || true
  echo "recorded $SCENE.mp4 (${SECS}s) — $SHOTDIR/$SCENE.mp4"
else
  # grab a frame for each marker the runner raises, until the host exits
  while kill -0 $HOST 2>/dev/null; do
    for r in "$SHOTDIR"/ready-*; do
      [ -e "$r" ] || continue
      name="$(basename "$r" | sed 's/^ready-//')"
      [ -e "$SHOTDIR/done-$name" ] && continue
      sleep 1
      DISPLAY="$DISP" ffmpeg -hide_banner -loglevel error -y -f x11grab -video_size 1600x1000 -i "$DISP" -frames:v 1 "$SHOTDIR/$name.png"
      touch "$SHOTDIR/done-$name"
      echo "captured $name.png"
    done
    sleep 1
  done
  echo "scene '$SCENE' done — frames in $SHOTDIR"
fi

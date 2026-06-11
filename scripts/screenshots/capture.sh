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
SCENE="${1:?scene required}"
WS="${2:-}"
if [ -z "$WS" ]; then
  if [ "$SCENE" = multiroot ]; then WS="$REPO/examples/orbit.code-workspace"; else WS="$REPO/examples/orbit-api"; fi
fi

# Isolate each scene: wipe the shared tmux socket (sessions persist across EDH
# restarts by design) and the example's writable state (pins / pending proposals)
# so a scene's sidebar reflects only what that scene sets up — not leftovers from
# a previous capture. Without this, lower sidebar sections shift and crops drift.
tmux -L tachyon kill-server 2>/dev/null || true
rm -f "$REPO"/examples/*/.tachyon/pins.json "$REPO"/examples/*/.tachyon/schedules-pending.json 2>/dev/null || true

SHOTDIR="$REPO/scripts/screenshots/out"; mkdir -p "$SHOTDIR"
CODE="$(ls -d "$REPO"/.vscode-test/vscode-linux-*/code 2>/dev/null | head -1)"
[ -x "$CODE" ] || { echo "VSCode test binary missing — run 'npm run test:integration' once first." >&2; exit 1; }
DISP=":97"; UDD="$SHOTDIR/udd"
rm -rf -- "$UDD"; mkdir -p "$UDD/User"
cat > "$UDD/User/settings.json" <<JSON
{ "workbench.startupEditor":"none","window.newWindowDimensions":"maximized","workbench.colorTheme":"Default Dark Modern","chat.commandCenter.enabled":false,"update.mode":"none","telemetry.telemetryLevel":"off","window.commandCenter":false,"workbench.layoutControl.enabled":false }
JSON

rm -f "$SHOTDIR"/ready-* "$SHOTDIR"/done-* 2>/dev/null || true
Xvfb "$DISP" -screen 0 1600x1000x24 >/dev/null 2>&1 & XVFB=$!
trap 'kill $XVFB 2>/dev/null || true' EXIT
sleep 2
SHOTDIR="$SHOTDIR" SCENE="$SCENE" DISPLAY="$DISP" \
  "$CODE" --extensionDevelopmentPath="$REPO" --extensionTestsPath="$REPO/scripts/screenshots/runner.js" \
  --user-data-dir "$UDD" --skip-welcome --skip-release-notes --disable-workspace-trust --disable-gpu \
  "$WS" >"$SHOTDIR/host.log" 2>&1 & HOST=$!

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

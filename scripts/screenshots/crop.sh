#!/usr/bin/env bash
# Crop raw 1600x1000 frames (scripts/screenshots/out/) into the docs assets.
# Rectangles are W:H:X:Y for a maximized 1600x1000 host; nudge if your chrome
# differs. Outputs to docs/screenshots/.
set -euo pipefail
cd "$(dirname "$0")/../.."
IN=scripts/screenshots/out; OUT=docs/screenshots; mkdir -p "$OUT"
c(){ ffmpeg -hide_banner -loglevel error -y -i "$IN/$1.png" -vf "crop=$2" "$OUT/$3.png"; echo "$3.png"; }

# full-window (trim black margins)
[ -f "$IN/hero.png" ]        && c hero        1440:912:80:48   hero
[ -f "$IN/multiroot.png" ]   && c multiroot   1440:912:80:48   multiroot
[ -f "$IN/inspector.png" ]   && c inspector   1440:912:80:48   inspector
[ -f "$IN/walkthrough.png" ] && c walkthrough 1440:912:80:48   walkthrough
# sidebar crops — ONE unified tree (v0.10.9): every section's Y depends on the
# rows above it in that scene. Rows are 22px tall; Bridge (row 0) tops out at
# y≈116. Scene row orders are stable because capture.sh wipes example state.
[ -f "$IN/observability.png" ] && c observability 300:224:127:113 observability  # Bridge..watcher (all 4 states)
[ -f "$IN/lineage.png" ]       && c lineage       300:200:127:114 subagents      # Bridge..shell (lineage under Agents)
[ -f "$IN/schedules.png" ]     && c schedules     300:90:127:270  schedules      # Pending approval..hourly-tests (paused)
[ -f "$IN/commands.png" ]      && c commands      300:112:127:313 commands       # Commands..ship
[ -f "$IN/pins.png" ]          && c pins          300:112:127:423 pins           # Pins..3 pins
# studio panel crops (single-group webview, form centered)
for t in agent terminal command runbook schedule; do
  [ -f "$IN/studio-$t.png" ] && c "studio-$t" 672:528:646:126 "studio-$t"
done
# studio 2x2 montage for the README
if [ -f "$OUT/studio-agent.png" ]; then
  ffmpeg -hide_banner -loglevel error -y -i "$OUT/studio-agent.png" -i "$OUT/studio-terminal.png" \
    -i "$OUT/studio-command.png" -i "$OUT/studio-runbook.png" \
    -filter_complex "[0][1]hstack[t];[2][3]hstack[b];[t][b]vstack,pad=iw+24:ih+24:12:12:0x0d1117" "$OUT/studio-grid.png"
  echo "studio-grid.png"
fi

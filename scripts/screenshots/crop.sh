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
# sidebar crops (the focused section sits at the top of the panel)
[ -f "$IN/observability.png" ] && c observability 350:262:80:110 observability
[ -f "$IN/lineage.png" ]       && c lineage       340:300:75:118 subagents
# sidebar view panes are fixed-height bands, so each section sits at a stable Y
[ -f "$IN/schedules.png" ]     && c schedules     350:120:80:320 schedules
[ -f "$IN/commands.png" ]      && c commands      350:144:80:524 commands
[ -f "$IN/pins.png" ]          && c pins          350:124:80:728 pins
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

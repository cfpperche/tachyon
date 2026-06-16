#!/usr/bin/env bash
# spec 224 — encode a recorded screencast (capture.sh --record <scene>) into web assets:
#   docs/screencasts/<name>.mp4  (h264, faststart — the site <video> + the linkable file)
#   docs/screencasts/<name>.webm (vp9 — smaller, modern browsers)
#   docs/screencasts/<name>-poster.png (a representative frame, the <video> poster + README still)
# Trims the recording's tail (the post-scene stopAll), crops the VSCode window out of the 1600x1000
# Xvfb frame (same rect as crop.sh's full-window shots), and scales to 1280 wide for the web.
#
# Usage: scripts/screenshots/cast.sh [in.mp4] [name] [secs] [poster_at_secs]
set -euo pipefail
cd "$(dirname "$0")/../.."
IN="${1:-scripts/screenshots/out/hero-cast.mp4}"
NAME="${2:-hero}"
SECS="${3:-26}"          # trim to drop the tail (beats end ~26s; stopAll follows)
POSTER_AT="${4:-18}"     # the verify-✓ + hover beat makes the strongest still
OUT=docs/screencasts; mkdir -p "$OUT"
VF="crop=1440:912:80:48,scale=1280:-2"   # window out of the 1600x1000 frame, then 1280 wide

ffmpeg -hide_banner -loglevel error -y -i "$IN" -t "$SECS" -vf "$VF" \
  -c:v libx264 -crf 23 -preset slow -pix_fmt yuv420p -movflags +faststart -an "$OUT/$NAME.mp4"
ffmpeg -hide_banner -loglevel error -y -i "$IN" -t "$SECS" -vf "$VF" \
  -c:v libvpx-vp9 -crf 34 -b:v 0 -pix_fmt yuv420p -an "$OUT/$NAME.webm"
ffmpeg -hide_banner -loglevel error -y -ss "$POSTER_AT" -i "$IN" -vf "$VF" -frames:v 1 "$OUT/$NAME-poster.png"

echo "encoded → $OUT:"
ls -la "$OUT"/"$NAME".mp4 "$OUT"/"$NAME".webm "$OUT"/"$NAME"-poster.png

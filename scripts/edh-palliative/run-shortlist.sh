#!/usr/bin/env bash
# UI shortlist visual dogfood — headless preview harness (mermaid / grok / handoff) + optional EDH fail-visible.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

OUT_BASE="${TACHYON_SHORTLIST_OUT:-$REPO/.tachyon/evidence/ui-shortlist}"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_BASE/$STAMP-$SHA"
mkdir -p "$OUT"

if [ $# -eq 0 ] || [ "${1:-}" = "shortlist" ] || [ "${1:-}" = "all" ]; then
  SCENES=(mermaid grok-activity handoff-distill)
else
  SCENES=("$@")
fi

# Ensure webview bundles exist (preview loads dist/webview/*).
if [ ! -f "$REPO/dist/webview/activity.js" ] || [ ! -f "$REPO/dist/webview/handoff.js" ]; then
  echo "shortlist: building webviews…"
  (cd "$REPO" && npm run build) || exit 1
fi

report="$OUT/result.json"
passed=()
failed=()
shots=()

run_preview() {
  local name="$1" view="$2" fixture="$3" width="${4:-900}"
  local png="$OUT/${name}.png"
  echo "shortlist: capture $name (view=$view fixture=$fixture)"
  if node "$REPO/scripts/edh-palliative/capture-preview-scene.mjs" \
    --view "$view" --fixture "$fixture" --out "$png" --width "$width"; then
    passed+=("$name")
    shots+=("$png")
  else
    failed+=("$name")
  fi
}

for scene in "${SCENES[@]}"; do
  case "$scene" in
    mermaid|mermaid-nav)
      # t-3febb9 / spec 374 — Activity mermaid read-only nav chrome
      run_preview "mermaid" "activity" "mermaid-nav" 900
      ;;
    grok|grok-activity|grok-feed)
      # t-9874be — Grok-shaped activity feed
      run_preview "grok-activity" "activity" "grok-feed" 900
      ;;
    handoff|handoff-distill|distill)
      # t-4eb7c0 — Handoff Distill target list UI
      run_preview "handoff-distill" "handoff" "distill-list" 900
      ;;
    fail-visible|edh)
      echo "shortlist: EDH fail-visible scene"
      if npm run dogfood:edh-palliative -- headless; then
        passed+=("fail-visible")
        # copy latest fail-visible png if present
        if [ -f "$REPO/.tachyon/evidence/edh-palliative/fail-visible.png" ]; then
          cp -f "$REPO/.tachyon/evidence/edh-palliative/fail-visible.png" "$OUT/fail-visible.png"
          shots+=("$OUT/fail-visible.png")
        fi
      else
        failed+=("fail-visible")
      fi
      ;;
    *)
      echo "shortlist: unknown scene '$scene' (mermaid|grok-activity|handoff-distill|fail-visible)" >&2
      failed+=("$scene")
      ;;
  esac
done

python3 - "$report" "$OUT" "$SHA" "${passed[@]:-}" -- "${failed[@]:-}" <<'PY'
import json, sys, os
report, out, sha = sys.argv[1], sys.argv[2], sys.argv[3]
args = sys.argv[4:]
if "--" in args:
    i = args.index("--")
    passed, failed = args[:i], args[i+1:]
else:
    passed, failed = args, []
# drop empty tokens from bash empty arrays
passed = [p for p in passed if p]
failed = [f for f in failed if f]
shots = sorted(f for f in os.listdir(out) if f.endswith(".png")) if os.path.isdir(out) else []
payload = {
    "ok": len(failed) == 0 and len(passed) > 0,
    "sha": sha,
    "out": out,
    "passed": passed,
    "failed": failed,
    "shots": shots,
    "scenes": {
        "mermaid": "t-3febb9 / spec 374 Activity mermaid-nav",
        "grok-activity": "t-9874be Grok activity feed",
        "handoff-distill": "t-4eb7c0 Handoff Distill targets",
        "fail-visible": "t-8354ae EDH Xvfb",
    },
}
open(report, "w").write(json.dumps(payload, indent=2) + "\n")
print(json.dumps(payload, indent=2))
sys.exit(0 if payload["ok"] else 1)
PY

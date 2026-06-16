# 224 — tachyon-hero-screencast — tasks

**Verify:** `bash -n scripts/screenshots/capture.sh scripts/screenshots/cast.sh` + manual playback check.

## Blocked on
- [ ] **Confirm D2 (deterministic vs real), D3 (xdotool pointer), D4 (README format)** with the
      maintainer. Then lock D1 (the beat list) and show a draft recording before encoding/wiring.

## Implementation (after confirm)
- [ ] 1. Rig **record mode** — `capture.sh --record <scene> <secs>` (ffmpeg `x11grab`) + `cast.sh`
      (encode MP4 h264 / WebM vp9 / optional GIF via palettegen+paletteuse; trim/crop).
- [ ] 2. **`hero-cast` scene** in `runner.js` — deterministic ~25s, D1 beats, `xdotool` pointer.
- [ ] 3. **Encode** MP4 + WebM (+ GIF if small); verify sizes (≤~3MB video; GIF ≤~5MB or skip).
- [ ] 4. **Wire** site (`<video autoplay loop muted playsinline poster>` + MP4/WebM sources) + README
      (poster→link per D4, or short GIF).
- [ ] 5. **Rig README** — document `--record` + `cast.sh` (the screencast path, alongside the existing
      hover/xdotool note).
- [ ] 6. **codex dueto** — rig shell correctness, ffmpeg/x11grab args, isolation intact, no flake.
- [ ] 7. **Ship** as a docs/site release (no extension version bump needed unless bundled).

## Notes
- Draft-first: record a ~25s draft, get the maintainer's nod on the choreography (D1) BEFORE encoding
  the final formats + wiring the pages — cheaper than re-cutting after.
- The site already references `docs/screenshots/hero.png`; that becomes the `<video>` poster.

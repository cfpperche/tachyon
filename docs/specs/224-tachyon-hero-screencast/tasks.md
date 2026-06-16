# 224 — tachyon-hero-screencast — tasks

**Verify:** `bash -n scripts/screenshots/capture.sh scripts/screenshots/cast.sh` + manual playback check.

## Decisions (confirmed with the maintainer 2026-06-16)
- **D2 = deterministic** (real declared agents + a sh+worktree tour). **D3 = xdotool pointer** (installed).
- **D4 = site `<video>` MP4+WebM; README = poster→mp4 link** (GitHub won't inline `<video>`).
- **D1 (beats) approved** after a draft: fleet → `feature` ⎇ → Verify ✓ on camera → HOVER reveals the
  inline actions (incl. Create PR) → codex → Bridge. **Editor fill = the review DIFF (iii)** — NOT the
  live claude TUI, which leaked name / plan / "bypass permissions" into a public asset (caught in the
  draft; switched to the diff).

## Implementation — DONE
- [x] 1. Rig **record mode** — `capture.sh --record <scene> [secs]` (ffmpeg `x11grab`, ready-cast/go-cast
      handshake so beats + recording start together) + `cast.sh` (trim 26s, crop, scale 1280, h264
      faststart + vp9 + poster). GIF dropped (D4 needs none).
- [x] 2. **`hero-cast` scene** — deterministic ~26s, xdotool pointer (guarded), diff fill, Verify ✓ on
      camera, hover-reveal of the inline actions.
- [x] 3. **Encoded** — docs/screencasts/hero.mp4 (424KB), hero.webm (584KB), hero-poster.png (374KB).
- [x] 4. **Wired** — site hero `<video autoplay loop muted playsinline poster>` (webm+mp4); README hero
      = poster `<img>` linked to the MP4 + a "watch" link.
- [x] 5. **Rig README** — `--record` + `cast.sh` documented (alongside the hover/xdotool note).
- [~] 6. **codex dueto** — running (rig shell correctness, ffmpeg args, isolation, determinism).
- [ ] 7. **Ship** — commit assets + rig changes; docs/site release (no extension bump).

## Notes
- Draft-first: record a ~25s draft, get the maintainer's nod on the choreography (D1) BEFORE encoding
  the final formats + wiring the pages — cheaper than re-cutting after.
- The site already references `docs/screenshots/hero.png`; that becomes the `<video>` poster.

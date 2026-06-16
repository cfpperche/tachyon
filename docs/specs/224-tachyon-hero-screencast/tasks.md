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
- [x] 6. **codex dueto** — 4 findings, all fixed: MAJOR record-mode never verified `ready-cast`
      (→ abort, don't record a bogus asset); MAJOR `hero-cast` swallowed setup failures then raised
      ready-cast (→ bail before ready-cast when the worktree didn't resolve); MINOR `wait $FF` under
      `set -e` leaked the VSCode host (→ trap kills HOST too + `wait || warn`); MINOR stale README hero
      caption (removed).
- [x] 6b. **Editor-fill fix (maintainer caught: the video showed only the diff the whole time).** The
      editor now opens on the LIVE claude orchestrator's terminal (maintainer OK'd the TUI text —
      already public), then transitions to the review diff — you see an agent working AND the review.
      Poster taken from the claude phase so the README still shows an agent too.
- [x] 7. **Shipped** — hero screencast at commit `2cd7295`; this follow-up re-records with the editor
      fix + the dueto fixes. docs/site release, no extension bump.

## Notes
- Draft-first: record a ~25s draft, get the maintainer's nod on the choreography (D1) BEFORE encoding
  the final formats + wiring the pages — cheaper than re-cutting after.
- The site already references `docs/screenshots/hero.png`; that becomes the `<video>` poster.

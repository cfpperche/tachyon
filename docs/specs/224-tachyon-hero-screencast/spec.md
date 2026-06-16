# 224 — tachyon-hero-screencast

_Created 2026-06-16._

**Status:** SHIPPED (2026-06-16, commits `2cd7295` + `00c5ad6`). Draft-first: recorded → maintainer
approved the arc (+ caught the editor-only-diff defect, fixed to claude-terminal→diff) → codex dueto
(4 rig findings fixed, round-2 SHIP). Docs/site release, no extension bump.
**Closure:** the hero is a ~25s live screencast — claude orchestrator in the editor → review diff →
Verify ✓ on camera → hover-revealed Create PR → fleet; site `<video>`, README poster→mp4 link.

**UI impact:** none (changes docs/landing assets + the screenshot rig; no extension code).

## Intent

Replace the **static hero** (`docs/screenshots/hero.png`) on the site and README with a **~25s
screencast of Tachyon actually working** — a real capture of the extension driving itself, same
"no mockups" ethos as the screenshot rig, just video instead of a frame.

## Approach

Extend the existing screenshot rig (headless VSCode under Xvfb, `runner.js` choreography, `ffmpeg`)
into a **screencast mode**: `ffmpeg x11grab` records the Xvfb display over a duration while a new
`hero-cast` scene choreographs the demo; then encode per surface. Reuses the rig's isolation (private
tmux socket + `XDG_CACHE_HOME`) so it never touches the live editor/agents.

## Decisions

- **D1 — choreography (~25s arc, to lock before recording):** a tight beat list. Proposal: (1) the
  Tachyon sidebar with the fleet, (2) an agent goes `running`, (3) **attention** fires (`needs you` 🔔),
  (4) a worktree agent (`⎇` + **Verify ✓**), (5) **Create PR** or **resume**. Pick the 3–4 that sell it.
- **D2 — deterministic vs real agents (CONFIRM):** proposed = **deterministic `sh`-scripted** (like the
  screenshot scenes) so the hero is reproducible/cheap/re-runnable each release, with output crafted to
  read as real. Alternative = real claude/codex (authentic but flaky/slow/costs a real interaction).
- **D3 — visible pointer (CONFIRM):** proposed = **`xdotool`** moves a visible cursor + clicks for the
  key beats, so each action has a visible cause (debuts the rig README's "synthetic pointer" path).
  Alternative = command-only (actions happen with no visible cause).
- **D4 — format per surface (CONFIRM):**
  - **Site (HTML):** `<video autoplay loop muted playsinline poster=hero.png>` with **MP4 (h264) +
    WebM (vp9)**. (Decided — best quality/size/control; the current hero.png is the poster fallback.)
  - **README (GitHub markdown):** `<video>` does NOT render there; only a **GIF** autoplays inline, and
    a 25s GIF is heavy (10MB+). Proposed = keep **hero.png as a clickable poster linking to the site
    video** (README stays light). Alternative = a short cropped GIF (~8–12s, ≤~5MB).
- **D5 — asset location:** commit MP4 + WebM (~1–3MB target) under `docs/screencasts/`; a GIF only if it
  stays small. No git-LFS for a single asset.

## Plan of work
1. **Rig record mode** — `capture.sh --record <scene> <secs>` (ffmpeg `x11grab` on the Xvfb DISPLAY →
   `out/<scene>.mp4`) + `cast.sh` to encode MP4/WebM/(GIF via palettegen/paletteuse) and trim/crop.
2. **`hero-cast` scene** in `runner.js` — deterministic, ~25s, the D1 beats, `xdotool` pointer.
3. **Encode** the 3 formats; verify sizes (MP4/WebM ≤~3MB; GIF only if ≤~5MB).
4. **Wire** the site (`<video>` + sources + poster) and the README (poster→link, or short GIF).
5. Verify playback + sane sizes; commit the assets + rig changes.

## Non-goals
- NOT `/video --mode code` (that's a synthetic HTML→MP4 composition; this must be a REAL screen
  recording of the extension working).
- No audio/voiceover, no captions/subtitles in v1.
- No change to extension code — rig + docs only.

## Acceptance
- A ~25s screencast captured live from the extension (deterministic scene, re-runnable), encoded to
  MP4 + WebM, committed under `docs/screencasts/` at a sane size; the site hero is an autoplaying,
  looping, muted `<video>` with the PNG poster fallback; the README hero resolves per D4.
- `capture.sh --record` + `cast.sh` documented in the rig README; the scene is reproducible.
- codex dueto (rig shell correctness, ffmpeg args, isolation intact) → SHIP; ship as a docs release.

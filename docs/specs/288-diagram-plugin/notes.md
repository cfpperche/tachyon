# 288 — diagram-plugin — notes

_Created 2026-06-28._

## Implementation (2026-06-28)

The plugin lives in the separate `tachyon-plugins` repo (like transcribe) — building it does NOT touch the Tachyon
extension working tree (so it ran in parallel with a concurrent extension refactor). Files:
`tachyon-plugins/diagram/{tachyon-plugin.json, skills/diagram/SKILL.md, skills/diagram/scripts/diagram.sh, README.md}`.

- **Chrome** = external tool reusing spec 285 + the spec-289 candidate `names`
  `[google-chrome, google-chrome-stable, chromium, chromium-browser]`, NO `detect` (a browser `--version` is
  slow/launchy; resolve+trust is enough → also means the card surfaces the resolved path, the no-detect path), per-PM
  assisted install (apt/dnf/pacman chromium + brew --cask google-chrome) + a manual that notes the Ubuntu snap.
- **mmdc** = pinned `@mermaid-js/mermaid-cli@11.15.0` via `npx -y -p ... mmdc`, `PUPPETEER_SKIP_DOWNLOAD=1` +
  `npm_config_ignore_scripts=true` (verified the render still works → kept per D1). Honest lower-trust npx lane;
  provenance JSONL under `.tachyon/` records package/version/`acquisition:npx`/`engine_checksummed:false`.
- **No data artifact** (D4). node assumed; missing npx → `unavailable` (D2).
- Output: `assets/diagrams/` default, canonical `.mmd` always written next to the render, contained to the workspace,
  never auto-staged, warns on a git-ignored path (D3).

## Impl codex dueto (2026-06-28) — SHIP-WITH-CHANGES, no BLOCKER, all folded (commit 295e9fb)

- **HIGH (D1):** removed the unpinned host-global `mmdc` fast path (it would run an unknown-version mmdc while
  recording provenance as the pinned npx version — both unpinned + false). Now test-only `DIAGRAM_MMDC` override else
  pinned npx only.
- **MEDIUM:** `--out` containment — reject paths escaping `$ROOT` (realpath check) + `--` terminators everywhere.
- **MEDIUM (D3):** always materialize the canonical `.mmd` next to the render — file input is copied into the out dir
  (skipped when it already is that file), never left orphaned at its original path.
- **MEDIUM:** remove a zero-byte output on the empty-output error branch too.
- **LOW:** JSON-escape the Chrome path in the puppeteer config (defense-in-depth; the shim path is already trusted).
- Confirmed safe by the dueto: source text + `--theme` argv-safe; unavailable/error branches correct + source always
  kept; `brew install --cask google-chrome` passes the engine's argv validator (first non-sudo exe = brew); no `git add`.

## Verified locally (render, not just static)

`DIAGRAM_CHROME_BIN=/usr/bin/google-chrome diagram.sh "flowchart..." --out .dgtest` → valid SVG via mmdc@11.15.0;
file input → canonical `.mmd` copied alongside; `--out ../../escape` → rejected; non-mermaid → `error`, source kept.

## Remaining — install-flow dogfood

The render is proven directly, but the INSTALL flow (Chrome multi-name detection on the card via spec 289, the
assisted-install affordance, the `_tachyon-external diagram chrome` runtime resolution) needs the extension PACKAGED
with spec 289 → a **0.53.2** build. Deferred until the extension working tree is clean (a concurrent `domainActions`
refactor by another agent is in flight; packaging now would capture its half-done state).

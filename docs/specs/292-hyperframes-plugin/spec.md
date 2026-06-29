# 292 — hyperframes-plugin

_Created 2026-06-29._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Intent

Migrate the **deterministic / free** half of the `video` capability as the Tachyon **`hyperframes`** plugin: an
HTML/CSS/JS composition → **MP4**, rendered LOCALLY via the HyperFrames CLI (`npx hyperframes@<pin>`, HeyGen,
Apache-2.0) + ffmpeg. Zero inference cost; the composition source is git-tracked, the MP4 is gitignored/regenerable.
The first of the split video pair (decided with the owner): **`hyperframes`** = local/deterministic (this spec);
**`video`** = paid/generative fal.ai (a later, separate plugin). This is the **diagram analog** extended to motion
(an npx engine + ffmpeg), proving the local-tool-plugin shape a fourth time.

### Official HeyGen skill — finding + decision (the owner's explicit question)

HeyGen ships a LARGE official, multi-runtime skill ecosystem in `heygen-com/hyperframes` (Apache-2.0):
`.claude-plugin` / `.codex-plugin` / `.cursor-plugin` + `skills/` with ~10 skills (embedded-captions 144 files,
hyperframes-animation 115, creative 67, media 40, cli 7, core 13, …) + a `skills-manifest.json` + `registry/`.

**Decision: use it as INSPIRATION + a thin Tachyon-native wrapper — do NOT vendor it.** Reasons:
1. It is hundreds of files across many skills — vendoring bloats the plugin + creates a re-sync burden on every HeyGen
   release; HeyGen already distributes the full suite as its OWN Claude/Codex/Cursor plugin (a Tachyon consumer who
   wants the deep authoring system can install that directly).
2. **`npx hyperframes init` is unsafe for a pinned plugin:** the official CLI skill states `init` checks + **pulls
   HeyGen's skills from GitHub into a GLOBAL set on every run**, and the `--skip-skills` flag is "currently neutered"
   — an unpinnable network + global-state side effect. So we must NOT scaffold via `init`; we ship our OWN minimal
   composition template (the Agent0 `/video` rationale, now independently confirmed).
3. The Tachyon plugin's value is the THIN wrapper: the pinned engine via npx, deps as external tools, the Tachyon
   install/consent/shim integration, a minimal scaffold + render — and a POINTER to HeyGen's official skills/docs for
   advanced authoring. We adapt only the tiny composition template, with Apache-2.0 attribution (CREDITS).

## Dependency shape (engine-first)

| Dependency | Model | Note |
|---|---|---|
| `npx` (Node ≥22) | ambient runner | like diagram's npx / audio's uvx — `command -v`, missing → `unavailable` |
| `hyperframes@<pin>` | the npx lower-trust lane | pinned exact version (the diagram-D1 pattern); Apache-2.0 |
| `ffmpeg` | external tool (285) | REQUIRED (the CLI states "requires Node ≥22 and FFmpeg") |
| headless Chrome | **likely hyperframes-managed** (puppeteer / `hyperframes browser`) — OQ1 | if internal → NOT a declared external tool |

Hoped-for outcome: **NO new engine** (npx + ffmpeg external; Chrome internal to hyperframes).

## Acceptance criteria

- [ ] **Scenario: scaffold → render a composition to MP4**
  - **Given** the plugin installed + npx + ffmpeg available
  - **When** the skill scaffolds a composition (owned minimal template) and runs `npx hyperframes@<pin> render`
  - **Then** it writes a tracked composition source + a (gitignored) MP4, `status=ok`, stayed-local
- [ ] **Scenario: graceful degradation** — no npx → `unavailable` (install Node ≥22); no ffmpeg → `unavailable`
- [ ] scaffolding ships our OWN minimal template (NO `hyperframes init` → no global-skills network pull)
- [ ] mmdc-style: `hyperframes` pinned to an EXACT version; first-run npm/Chromium fetch disclosed; provenance records
      `engine:hyperframes@<pin>`, `acquisition:npx`, `engine_checksummed:false`
- [ ] ffmpeg surfaces as an external tool on the drawer/card (285/287); Chrome handled per OQ1
- [ ] self-contained in `tachyon-plugins/hyperframes/` (manifest + skill + script + minimal template + README + CREDITS attribution); zero Agent0 refs
- [ ] NO new engine (unless OQ1 forces one — engine-first if so)
- [ ] output contained to the workspace; composition source tracked, MP4 gitignored; never auto-staged

## Non-goals

- The paid/generative fal.ai lane (the separate `video` plugin).
- Vendoring HeyGen's full skill suite / using `hyperframes init` (global-skills pull).
- HyperFrames `cloud`/`lambda` rendering (paid AWS) — local render only, by design (zero marginal cost).
- A deep authoring system — ship a minimal template + point to HeyGen's official skills for advanced work.

## Open questions

- **OQ1 — does HyperFrames need a SYSTEM Chrome, or manage its own?** The Agent0 note + the `hyperframes browser`
  subcommand suggest it manages its own Chromium (puppeteer). If internal → deps = npx + ffmpeg only (no Chrome
  external tool), but the first render downloads Chromium (~150 MB?) via the engine (the npx lane) — disclose it.
  Verify at design/build time; if it actually needs system Chrome, declare it as a 289-multi-name external tool (like
  diagram). DECISIVE for the manifest's externalTools.
- **OQ2 — minimal owned template content.** Confirm a tiny hand-authored composition (`index.html` +
  `hyperframes.json` + `package.json`) renders via `npx hyperframes render` WITHOUT `init` having pulled the global
  skills. (Adapt the Agent0 template, Apache-2.0 attributed.)
- **OQ3 — render invocation + output.** `render` is "project-based" (runs from inside the composition dir);
  `--output out.mp4` + `--quality draft|high`. Map to a contained output path (composition under
  `assets/video/compositions/<slug>/`, MP4 under a gitignored generated dir); confirm `--json`/exit-code handling
  (render has no `--json`; verify via exit code + the output file).
- **OQ4 — authoring guidance depth.** A thin `references/authoring.md` + a pointer to HeyGen's official skills, vs a
  fuller guide. Lean: thin + pointer (don't duplicate the upstream authoring system).
- **OQ5 — pin + drift.** hyperframes is pre-1.0 (0.7.18); pin exact + note minor-version render drift (a refresh
  routine, like the diagram/audio pins).

## Context / references

- spec 288 (diagram) — the npx-engine + external-tool local-plugin shape to mirror; spec 289 (candidate names) — if
  Chrome turns out to be a system external tool; spec 285/287 — ffmpeg external-tool surfacing.
- The source: Agent0 `/video` `--mode code` (`code.sh` scaffold/render/doctor + the owned composition template +
  `authoring.md`) — the behavioural contract (own the authoring layer, depend on the engine; avoid `init`).
- Upstream: `heygen-com/hyperframes` (Apache-2.0) — the CLI engine (pinned via npx) + the official skills (inspiration
  + a pointer for deep authoring; NOT vendored).

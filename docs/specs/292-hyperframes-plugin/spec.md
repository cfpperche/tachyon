# 292 — hyperframes-plugin

_Created 2026-06-29._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Design decisions (folded from the 2026-06-29 codex design dueto — SHIP-WITH-CHANGES → all folded)

The dueto read the ACTUAL `hyperframes` code in the npx cache. Decisions:

- **D0 — NO new engine.** Same lower-trust pinned-`npx` lane as diagram (mmdc) + `ffmpeg` external tool. No data/tool
  provisioning engine.
- **D1 — Chrome is NOT a Tachyon external tool; the manifest declares `ffmpeg` ONLY.** HyperFrames owns the browser
  layer: local render uses Puppeteer (bundled Chromium) + system FFmpeg; it downloads Chrome Headless Shell into its
  OWN cache when needed (and may fall back to a system Chrome). So we do NOT declare/resolve Chrome. The first-run
  Chromium download is part of the disclosed npx lower-trust lane. Provenance records `hyperframes_version`,
  `browser_source`, `acquisition:"npx"`, `engine_checksummed:false`.
- **D2 — fail CLOSED on Linux ARM / no-browser (security).** On Linux ARM with no browser present, the upstream CLI
  has a code path that attempts an `apt-get install` (package-manager mutation we do NOT control). The wrapper must
  detect that situation and return `unavailable` with a manual hint — NEVER let `hyperframes` run a package install.
- **D3 — ship our OWN minimal composition template; do NOT use `hyperframes init`.** Load-bearing reason: `init`
  couples the plugin to upstream scaffolding, remote examples, media preprocessing, and optional global-skills pulls —
  unpinnable + impure. (NB: the "`--skip-skills` is neutered" claim is from the CLI skill doc and was NOT verified in
  the 0.7.18 code — do not rely on it; the coupling argument stands on its own.) Render does NOT need the global
  skills (they are authoring guidance, not render runtime) — but this MUST be proven (acceptance heavy-proof).
- **D4 — verify Node ≥ 22, not just `npx` present.** HyperFrames requires Node >=22; `command -v npx` is insufficient.
  Missing/old Node → `unavailable` with the version hint.
- **D5 — official skill = INSPIRATION, NOT vendored** (confirmed). Thin wrapper: scaffold a minimal usable composition,
  render locally, point advanced authoring at HeyGen's plugin/docs. Apache-2.0 attribution for any adapted
  template/docs in `CREDITS`/README; running the CLI via `npx` (not bundling) is clean.
- **D6 — `doctor` wraps `hyperframes doctor --json`** but parses only the RELEVANT checks (Node, FFmpeg/FFprobe,
  Chrome/browser, memory/shm) — do NOT trust the aggregate `ok` (it includes Docker checks irrelevant to local render).

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
- [ ] **Scenario: graceful degradation** — no npx OR Node < 22 → `unavailable` (install Node ≥22); no ffmpeg → `unavailable`
- [ ] **Scenario (security): Linux ARM / no-browser fails closed** — the wrapper returns `unavailable`, NEVER lets
      `hyperframes` run an `apt-get install` (D2)
- [ ] scaffolding ships our OWN minimal template; the scripts NEVER invoke `hyperframes init` (D3)
- [ ] manifest declares `ffmpeg` ONLY (Chrome is hyperframes-managed — D1); ffmpeg surfaces on the drawer/card (285/287)
- [ ] `hyperframes` pinned to an EXACT version (0.7.18); first-run Chromium/npm fetch disclosed; provenance records
      `hyperframes_version`, `browser_source`, `acquisition:"npx"`, `engine_checksummed:false`
- [ ] **HEAVY PROOF (one):** from a CLEAN dir with NO `hyperframes init` + no global-skills assumption, the owned
      template renders via `npx hyperframes@0.7.18 render --quality draft --workers 1 --output <contained>.mp4` → a
      non-empty MP4. (Fallback if it fails: copy the minimum project/runtime files into the owned template — never
      invoke `init` at runtime.)
- [ ] cheap headless coverage: manifest parse, scaffold, path containment, no-npx/no-ffmpeg/old-node fail-closed,
      no `init`/no `apt` in the scripts
- [ ] self-contained in `tachyon-plugins/hyperframes/` (manifest + skill + script + minimal template + README + CREDITS); zero Agent0 refs
- [ ] NO new engine (D0)
- [ ] output contained to the workspace; composition source tracked, MP4 gitignored; never auto-staged

## Non-goals

- The paid/generative fal.ai lane (the separate `video` plugin).
- Vendoring HeyGen's full skill suite / using `hyperframes init` (global-skills pull).
- HyperFrames `cloud`/`lambda` rendering (paid AWS) — local render only, by design (zero marginal cost).
- A deep authoring system — ship a minimal template + point to HeyGen's official skills for advanced work.

## Open questions

_All resolved by the 2026-06-29 design dueto — see § Design decisions. The build must land the one HEAVY render proof
(acceptance) which doubles as the last open verification (does the owned template render with no `init`)._

- **OQ1 — Chrome.** RESOLVED → D1: hyperframes-managed; manifest = ffmpeg only.
- **OQ2 — render without global skills.** RESOLVED (low-risk) → D3 + the heavy proof; fallback = copy minimum runtime files.
- **OQ3 — render invocation/output.** `render --quality draft --workers 1 --output <contained>.mp4`, project-based cwd;
  verify via exit code + the output file (render has no `--json`). Composition under a tracked dir, MP4 gitignored.
- **OQ4 — authoring depth.** RESOLVED → D5: thin reference + pointer to HeyGen; don't duplicate the upstream system.
- **OQ5 — pin/drift.** RESOLVED → pin `hyperframes@0.7.18` exact; pre-1.0 render drift noted (refresh routine later).

## Context / references

- spec 288 (diagram) — the npx-engine + external-tool local-plugin shape to mirror; spec 289 (candidate names) — if
  Chrome turns out to be a system external tool; spec 285/287 — ffmpeg external-tool surfacing.
- The source: Agent0 `/video` `--mode code` (`code.sh` scaffold/render/doctor + the owned composition template +
  `authoring.md`) — the behavioural contract (own the authoring layer, depend on the engine; avoid `init`).
- Upstream: `heygen-com/hyperframes` (Apache-2.0) — the CLI engine (pinned via npx) + the official skills (inspiration
  + a pointer for deep authoring; NOT vendored).

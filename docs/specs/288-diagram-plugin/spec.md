# 288 — diagram-plugin

_Created 2026-06-28._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Design decisions (folded from the 2026-06-28 codex design dueto — NEEDS-REVISION → all folded)

- **D1 — OQ1 mmdc acquisition = HYBRID (a), made honest. NO new engine capability.** The plugin script runs
  `npx -p @mermaid-js/mermaid-cli@<EXACT-VERSION> mmdc` — never a floating version. Option (b) (an npm-package
  provisioning engine) is **rejected as disproportionate**: a correct npm provisioner is a real engine product
  (full transitive-lockfile integrity, lifecycle-script policy, native-module handling, offline-cache layout,
  update semantics) — not a one-plugin prerequisite. (b) is also not justified by reproducibility alone, since
  system Chrome + fonts are already external/unpinned. **mmdc is NOT the same class as Chrome** (Chrome is
  engine-declared via `externalTools`, surfaced at install, resolved fail-closed via `_tachyon-external`; `npx` is
  INVISIBLE to the engine) — so this is an explicit, recorded engine deviation, a **lower-trust npm acquisition
  tier**, not a peer of the external-tool model.
- **D1 requirements (what makes (a) honest):** exact pinned version; `PUPPETEER_SKIP_DOWNLOAD=1`;
  test `npm_config_ignore_scripts=true` and REQUIRE it if it still renders (block npm lifecycle-script execution —
  supply-chain hardening); the first-run npm network fetch is DISCLOSED in the README/spec and surfaced by
  `doctor`/`caps`; run provenance records `mmdc_package`, `mmdc_version`, `acquisition:"npx"`,
  `engine_checksummed:false`; offline-after-warm-cache is **best-effort, explicitly NOT promised** unless proven.
- **D2 — OQ2: node is ASSUMED (Tachyon's Node, which the resolver shims already exec), NOT declared as an external
  tool** (no truthful install/surfacing contract for it). `npx` is a separate concern: a MISSING `npx` →
  `status=unavailable` with manual guidance (do not silently fail). Only declare `npx` as an external tool if real
  truthful external-tool support is added — not in v1.
- **D3 — OQ3 output ownership:** default render dir `assets/diagrams/`; ALWAYS write the `.mmd` source next to the
  render (the durable artifact); **never auto-stage** (no `git add`); honour `--out`; **warn if `git check-ignore`
  reports the output path is ignored** (so the asset isn't silently lost). Run provenance goes under `.tachyon/`
  (or a clearly-documented JSONL path), never scattered in the repo.
- **D4 — OQ4 CLOSED: diagram needs NO data-artifact engine (spec 284).** There is no model/weights/static ruleset.
  Do not abuse spec 284 for npm.

## Intent

Migrate the `diagram` capability (deterministic technical diagrams — Mermaid source → tracked SVG/PNG/PDF,
local + free) into a Tachyon plugin, the second local tool-plugin after `transcribe` (spec 286). A skill
(`description`-selectable) wraps a `scripts/diagram.sh` that renders a Mermaid source through `mmdc`
(`@mermaid-js/mermaid-cli`) in a **system** headless Chrome, degrading to **validation-only** when Chrome/Node
is absent (the source is always kept — never a dead artifact).

The capability is **deterministic + free** (no paid lane, no API key, no tiers) — the diagram counterpart of the
`transcribe`-class local utility. Unlike a photo (`/image`, paid) or motion (`/video`), the output is a real,
reproducible asset file from a text spec.

### Dependency shape (the crux)

- **Chrome/Chromium** — a SYSTEM browser, used headless to render. Maps cleanly onto the **external-tool engine
  (spec 285)**: detect spoof-resistantly, offer a consent-gated assisted install (apt/dnf/pacman/brew), resolve
  via `_tachyon-external` at runtime, degrade to validation-only when absent.
- **node** — required to run `mmdc` (and the resolver shims already need it). Either declared as an external tool
  or assumed present (the plugin shims exec node already).
- **mmdc** (`@mermaid-js/mermaid-cli`) — an **npm package**, NOT a single pinned binary (spec 265) nor a system
  binary (spec 285) nor a data file (spec 284). Today the Agent0 tool acquires it via `npx -p @mermaid-js/mermaid-cli
  mmdc` (PUPPETEER_SKIP_DOWNLOAD=1 so npx pulls only the JS package, rendering in system Chrome). **This is the open
  design question** (see OQ1) — and the engine-first gate: resolve the mmdc-provisioning approach BEFORE building.

## Acceptance criteria

- [ ] **Scenario: render a Mermaid source to a tracked asset**
  - **Given** the diagram plugin is installed and Chrome + node/mmdc are available
  - **When** the skill runs `diagram.sh "<mermaid source>" --format svg`
  - **Then** it writes a tracked SVG (and keeps the `.mmd` source) and reports `status=ok` with the asset path
- [ ] **Scenario: graceful degradation (no Chrome)**
  - **Given** no usable system Chrome/Chromium
  - **When** the skill runs
  - **Then** it structurally validates the Mermaid source, KEEPS it, and reports `status=unavailable` with an
    install hint — never a dead/empty artifact
- [ ] **Scenario: external-tool surfacing (reuses spec 285/287)**
  - **Given** the plugin declares Chrome (and node?) as external tools
  - **When** the install drawer / installed card renders
  - **Then** Chrome shows present/missing with a consent-gated assisted install for a missing one (apt/dnf/pacman/brew)
- [ ] **Scenario: missing npx → unavailable (not a crash)**
  - **Given** no `npx` on PATH
  - **When** the skill runs
  - **Then** it reports `status=unavailable` with manual guidance (install Node/npx) and keeps the validated source
- [ ] mmdc is acquired at an EXACT pinned version via `npx -p @mermaid-js/mermaid-cli@<version> mmdc` with
      `PUPPETEER_SKIP_DOWNLOAD=1` and (if it still renders) `npm_config_ignore_scripts=true`; the first-run npm
      network fetch is disclosed in README + surfaced by `doctor`/`caps`
- [ ] run provenance records `mmdc_package`, `mmdc_version`, `acquisition:"npx"`, `engine_checksummed:false`
      (the honest lower-trust tier — D1), written under `.tachyon/` (or a documented JSONL path)
- [ ] manifest loads with **0 errors**; the install preview surfaces the Chrome external-tool status (present/missing)
- [ ] output: writes `.mmd` next to the render, defaults to `assets/diagrams/`, honours `--out`, **never auto-stages**,
      and **warns when `git check-ignore` reports the output path is ignored**
- [ ] warm-cache/offline behavior is either PROVEN by a test or explicitly documented as NOT promised
- [ ] the plugin is self-contained in `tachyon-plugins/diagram/` (manifest + skill + script + README); zero Agent0
      references (per the Tachyon-no-Agent0 rule)
- [ ] NO new engine capability is built (D1: hybrid-(a) needs none); diagram reuses spec 285 (Chrome) only

## Non-goals

- Non-Mermaid diagram languages (Graphviz/PlantUML/D2) — Mermaid-only v1, exactly as the source capability.
- Custom styling / design craft (that's `/frontend-designer`); only Mermaid built-in themes.
- A paid/cloud render lane — diagram is deterministic + free by definition.
- Bundling Chromium (the engine reuses SYSTEM Chrome; no 100+ MB browser download).

## Open questions

_All four resolved by the 2026-06-28 design dueto — see § Design decisions D1–D4._

- **OQ1 — mmdc acquisition.** RESOLVED → D1: hybrid (a), exact-version `npx`, made honest (no new engine).
- **OQ2 — node external-tool vs assumed.** RESOLVED → D2: assume Tachyon's Node; missing `npx` → `unavailable`.
- **OQ3 — output storage + provenance.** RESOLVED → D3: `assets/diagrams/` default, `.mmd` alongside, never
  auto-stage, `--out`, warn on `git check-ignore`, provenance under `.tachyon/`.
- **OQ4 — data-artifact engine?** RESOLVED → D4: no — diagram uses no data artifact.

## Context / references

- spec 286 (transcribe-plugin) — the first local tool-plugin; the shape to mirror (skill + script + external tools).
- spec 285 (external-tool requirements) — Chrome (and maybe node) map onto this directly.
- spec 287 (plugin-install-ux) — the installed-card external-tool surfacing + assisted install Chrome will reuse.
- spec 265 (provisioned tools) / 284 (data artifacts) — the two existing provisioning models mmdc does NOT fit,
  motivating OQ1.
- The source capability: the Agent0 `diagram` skill + `diagram.sh` tool (Mermaid-only, npx mmdc, system Chrome,
  validation-only degradation) — the behavioural contract to preserve.

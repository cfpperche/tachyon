# 294 — product-foundation-plugin

_Created 2026-06-29._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Design decisions (folded from the 2026-06-29 codex design dueto — SHARPEN ×3, all folded)

- **D0 — NAME = `product-foundation`.** The source skill is `/product`, but `product` is too broad for a marketplace
  (reads as PM advice / a product app / "this builds my product"). The plugin's actual promise is narrow and strong:
  idea → a docs-first product **foundation** → a visual contract → an SDD handoff (NOT a runnable app), which is what the
  skill already calls itself ("foundation generator"). Slug **`product-foundation`**, display **"Product Foundation"**,
  aliases/tags `product`, `blueprint`, `prd`, `sdd-handoff` (continuity + discoverability). A two-word kebab slug is not
  a liability here — it prevents the worst expectation bug ("this builds my product").
- **D1 — RUNTIME scope is capability-gated, owner ruling (2026-06-29): claude+codex ONLY if codex can do the
  orchestration NATIVELY; otherwise ship CLAUDE-ONLY in v1 + codex fast-follow.** The pipeline CORE (the 15 step
  prompts, templates, `references/`, the Open-Design `design-systems/` vendor bundle, the TS scripts) is runtime-neutral
  and ports verbatim. The product, though, is the **delegated, stateful orchestration**, not the prompts. The decisive
  question is therefore NOT `AskUserQuestion` (inline structured gates that record the decision into `.state.json` are a
  fine codex degrade) — it is whether codex can natively drive: parallel producer waves, per-phase quality-judge batches,
  schema validation + BLOCK/re-dispatch, state mutation, and the Phase-5 SDD scaffold. **Build step B0 is a codex
  orchestration-capability probe** (incl. that codex cannot ENFORCE the 5-field spawn brief — convention-only): if a
  real codex adapter + a full-pipeline codex dogfood (all 4 gates, state writes, ≥1 BLOCK/retry path, Phase-5 scaffold)
  is achievable, v1 ships `blocks: {claude, codex}`; if not, v1 is claude-only and codex is a fast-follow. A HOLLOW codex
  port is worse than delayed parity. Sequential fan-out on codex is an honest degrade; **skipping judge batches or
  weakening gates is NOT** an acceptable degrade.
- **D2 — the referenced `mcp-product-pipeline` MCP is DEAD; strip the prose but RE-HOME its live invariants.** Verified:
  no `packages/` dir, no `mcp-product-pipeline` package — it does not exist. The skill TEMPLATES still carry MCP cruft
  (`product_step_submit`, `{code:"schema-incomplete", missing_or_invalid:[…]}`, "the MCP regex-extracts `validation_mode:`
  into state", "a future delivery-plan MCP step"). The plugin ships **NO MCP block** and the terminology is stripped — BUT
  the following are LOAD-BEARING invariants the MCP prose merely named, and they must be re-homed into a plugin-native
  validation/state surface (orchestrator body + scripts), NOT deleted with the wording:
  1. **`validation_mode:` extraction** (Step 04 writes the `tested|intuition|not-applicable` line; the roadmap reads it
     downstream).
  2. **Layer-1 schema-completeness** — required headings, `min_size` floors, `contains` checks, multi-file bundle checks,
     and precise `schema-incomplete`-style failure reporting (which step/file/field is missing).
  3. **Atomic multi-file write semantics** (e.g. system-design's bundle) — partial writes must not advance state.
  4. **Explicit `.state.json` transitions** — the progression formerly implied by `product_advance` / `gate_pass`
     becomes explicit state writes (phase/step/gates_passed/completed_steps/…).
  The replacement contract phrasing is: *"the orchestrator validates the schema floors, writes artifacts atomically,
  extracts the declared state fields, and records phase progression in `.state.json`."* Speculative "future MCP" lines
  become "post-pipeline SDD/plugin work" or are removed.
- **D3 — it is a SKILL-PAYLOAD plugin (no new engine).** `product-foundation` materializes a skill block per runtime
  (`blocks`), bundling the pipeline templates + references + the Apache-2.0 Open-Design `design-systems/` vendor tree +
  the TS scripts. No external tools to provision for the core (the optional best-effort visual check drives the
  runtime-neutral `agent-browser` primitive, which is the host's, not the plugin's — fail-closed/skip when absent, never
  an MCP fallback, per the source's spec 153). Confirm "no new engine" holds (the design-system bundle size + the
  scripts are the only weight) during the build.
- **D4 — zero Agent0 references (public-surface hygiene).** The plugin (manifest + skill + templates + references +
  vendor bundle + README) is self-contained in `tachyon-plugins/product-foundation/` and names no Agent0 path/skill;
  the SDD handoff targets the `sdd` plugin generically.
- **D5 — PAID/EXTERNAL safety.** The pipeline makes no paid calls and no network calls of its own (unlike the fal media
  plugins); the only optional external surface is `agent-browser` for the best-effort visual check. The headless dogfood
  runs the pipeline shape (or a representative slice) with no paid dependency.

## Intent

Migrate the Agent0 `/product` skill — the foundation generator + design partner for the product lifecycle (idea → v1 →
vN) — into the Tachyon marketplace plugin **`product-foundation`**. It is the last PLUGIN in the skills migration
(`brainstorm` was dropped 2026-06-29; `frontend-designer` is gated on the Tachyon UI-acceptance harness), and the
biggest/most complex: a 15-step pipeline that turns a one-line idea into a complete **docs-first** product foundation
(concept brief with a binding product-form declaration, functional spec with an assumption register, UX audit, PRD, OST,
sitemap-IA, system design, legal posture, roadmap/cost/GTM as labeled pre-validation projections, brand book, design
system) plus a **visual contract** (lo-fi mood + screen-atlas + hi-fi killer-flow mood + fixture-spec), then a mandatory
**SDD handoff** that scaffolds the umbrella + foundation child spec the engineering build runs as. It produces planning
artifacts, NOT a runnable app.

"Done" is a self-contained `tachyon-plugins/product-foundation/` plugin that installs via the engine, materializes the
pipeline as a skill block, and runs the foundation pipeline through its phase/gate/state machine — with the dead MCP
architecture stripped and its real invariants re-homed into a plugin-native validation/state contract, named cleanly
(`product-foundation`), and either multi-runtime (claude+codex) or claude-only-v1 per the D1 codex-capability probe.

## Acceptance criteria

- [ ] **Scenario: installs as a skill plugin**
  - **Given** the `product-foundation` plugin in `tachyon-plugins/`
  - **When** it is installed via the engine into a workspace
  - **Then** the pipeline skill block materializes for each declared runtime (no MCP block, no new engine), the lockfile
    records the skill, and there are zero Agent0 references in the shipped tree
- [ ] **Scenario: the pipeline runs through its state machine**
  - **Given** an installed `product-foundation` and a one-line idea
  - **When** the pipeline runs (headless dogfood, full shape or a representative slice)
  - **Then** it advances phase/step through `.state.json`, enforces the concept kill-gate + phase gates, and produces the
    docs-first foundation tree + the visual contract + the SDD handoff scaffold
- [ ] **Scenario: the dead MCP invariants survive the strip (D2)**
  - **Given** the stripped plugin (no `product_step_submit` / `schema-incomplete` / "MCP regex-extracts" prose)
  - **When** a step submits an artifact that violates a schema floor (missing required heading / under `min_size` /
    missing a `contains` token / an incomplete multi-file bundle / a missing `validation_mode:` line)
  - **Then** the plugin-native validator REJECTS it with a precise schema-incomplete-style failure (which step/file/field),
    does NOT advance `.state.json`, and the `validation_mode:` field is still extracted into state for the roadmap to read
- [ ] **Scenario: runtime scope matches the codex-capability probe (D1)**
  - **Given** the B0 probe verdict on codex native orchestration (parallel waves / judge batches / BLOCK-redispatch /
    state / Phase-5 scaffold)
  - **When** v1 is packaged
  - **Then** IF codex can drive it natively (proven by a full-pipeline codex dogfood through all 4 gates + ≥1 BLOCK/retry
    + Phase-5 scaffold) the plugin ships `blocks: {claude, codex}`; ELSE v1 ships claude-only and codex is recorded as a
    fast-follow — never a hollow codex port, and no codex degrade that skips judge batches or weakens a gate
- [ ] product-form awareness preserved (screen-app / headless-service / cli / bot / embedded adapt the relevant steps)
- [ ] the Open-Design `design-systems/` vendor bundle ships with its Apache-2.0 LICENSE/NOTICE intact
- [ ] both codex duetos (design — this; impl — post-build) folded; headless dogfood green; spec closed with a `**Closure:**`
- [ ] NO new engine (skill-payload plugin only); the optional visual check uses the host `agent-browser`, fail-closed when absent

## Non-goals

- Generating a runnable app (the pipeline is docs-first; the app build is the SDD workflow on the scaffolded specs).
- Re-introducing any MCP (the `mcp-product-pipeline` architecture is dead and not revived; D2).
- `frontend-designer` (a separate, UI-acceptance-gated migration) and `brainstorm` (dropped 2026-06-29).
- Changing the pipeline's substance (the 15 steps / gates / judge protocol are migrated, not redesigned) beyond the MCP
  strip + re-home and the runtime adapter.

## Open questions

- **OQ1 — codex native orchestration (the D1 gate).** Can codex natively drive the delegated stateful pipeline (parallel
  producer waves, judge batches, BLOCK/re-dispatch, state writes, Phase-5 scaffold) well enough for an HONEST v1 port?
  → Resolved by the build's **B0 probe**; if no, v1 is claude-only + codex fast-follow (owner ruling 2026-06-29).
- **OQ2 — the plugin-native validation surface shape.** Is Layer-1 schema-completeness best expressed as a bundled
  validator script the skill body calls, or as inline body discipline? → Resolve in `/sdd plan` (lean: a small bundled
  validator script so the floors are mechanical + testable, mirroring the source's Layer-1).
- **OQ3 — design-system bundle weight vs the artifact-size posture.** The ~150 vendored Open-Design systems are large;
  confirm they don't trip the engine's size posture and decide whether all ship or a curated subset. → Resolve in `/sdd plan`.

## Context / references

- The source: Agent0 `/product` skill (`.claude/skills/product/` — SKILL.md, `templates/pipeline/NN-*/`, `references/`,
  `design-systems/`, `scripts/`), v0.6.0, `agent0-portability-tier: cc-native`.
- spec 291 (image/sound) / 292 (hyperframes) / 293 (video) — the prior plugin migrations + the design/impl dueto cadence.
- The 2026-06-29 codex design dueto: `.agent0/.runtime-state/codex-exec/product-plugin-dueto-result.md` (in the Agent0
  repo — the planning side; this spec is its Tachyon-side landing).

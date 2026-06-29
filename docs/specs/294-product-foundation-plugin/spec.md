# 294 — product-foundation-plugin

_Created 2026-06-29._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** Shipped 2026-06-29 in `tachyon-plugins/product-foundation/` — the last skill migration. The `/product` 15-step pipeline migrated via wholesale copy + four rewrite sweeps (rename → MCP-strip → de-Agent0 → agent-browser dependency). `/sdd plan` (plan.md + tasks.md) and both codex duetos folded — design (SHARPEN ×3) and impl (NEEDS-REVISION → resolved). The impl dueto's crux (the dead MCP *was* the validator, so the strip left the Layer-1 invariant unenforced) was resolved by building a plugin-native validator (`scripts/validate-step.ts`, bun) that parses each step's `required_files` floor (exists/min_size/contains/any_of_contains) and emits `schema-incomplete` + exits nonzero; it is wired into the SKILL.md body (a new § Layer-1 validation) so a step is re-dispatched, never advanced, on failure. All 15 steps now carry a machine-readable floor (added blocks to 06/07/12/15). Also folded: the report.md.tmpl agent-browser.sh/spec-153 leak, the 04-validation + 09-legal active step-routing errors, the prototype-v3 ghost relabel, the src/templates.ts citation, the sync-open-design MCP name, a concrete visual-check verb sequence, and the README Bun-required note. Verified by a headless install dogfood (loadPlugin 0 errors; skill + ~6 MB/151 design-systems + LICENSE/NOTICE materialize; lockfile; the agent-browser dependency surfaces missing + non-blocking; the validator materializes and enforces a floor — stub→schema-incomplete, complete→ok) and a clean D4/dead-MCP token sweep. **Known limitation (inherited source drift, documented not fully reconciled):** some step templates still carry descriptive "gates fire after steps 4/7/12" phrasing from an older pipeline architecture; the SKILL.md orchestrator is the authoritative flow (gate_concept/discovery/specification/identity), and the active producer-routing errors were corrected. Commits: tachyon-plugins `feat` + `01b77ec` (fold); tachyon spec/plan/tasks. Pending (gated): tachyon-plugins push + tag (v0.22.0) + the site banner, on the owner's OK. Codex is a deliberate fast-follow (D1).

## Design decisions (folded from the 2026-06-29 codex design dueto — SHARPEN ×3, all folded)

- **D0 — NAME = `product-foundation`.** The source skill is `/product`, but `product` is too broad for a marketplace
  (reads as PM advice / a product app / "this builds my product"). The plugin's actual promise is narrow and strong:
  idea → a docs-first product **foundation** → a visual contract → an SDD handoff (NOT a runnable app), which is what the
  skill already calls itself ("foundation generator"). Slug **`product-foundation`**, display **"Product Foundation"**,
  aliases/tags `product`, `blueprint`, `prd`, `sdd-handoff` (continuity + discoverability). A two-word kebab slug is not
  a liability here — it prevents the worst expectation bug ("this builds my product").
- **D1 — RUNTIME scope RESOLVED (owner ruling 2026-06-29): v1 is CLAUDE-ONLY; codex is a fast-follow spec.** The owner's
  rule was "claude+codex only if codex can do the orchestration NATIVELY, else claude-only v1." Applying it: the pipeline
  CORE (the 15 step prompts, templates, `references/`, the Open-Design `design-systems/` vendor bundle, the TS scripts)
  is runtime-neutral and ports verbatim — but the PRODUCT is the **delegated, stateful orchestration**, not the prompts.
  The decisive surface is NOT `AskUserQuestion` (inline structured gates that record into `.state.json` degrade fine) and
  NOT the visual check (the browser machinery is solved by depending on the `agent-browser` plugin — D3, which is itself
  already claude+codex). It is the spine: parallel producer waves, per-phase quality-judge batches, schema-validation +
  BLOCK/re-dispatch, and the Phase-5 SDD scaffold, dispatched through the runtime's sub-agent mechanism. Codex sub-agent
  delegation is **convention-only** (it cannot natively ENFORCE the 5-field spawn brief the pipeline's dispatch relies
  on), so by the owner's rule codex does NOT natively have the orchestration → **v1 ships claude-only** (`blocks:
  {claude}`). A HOLLOW codex port is worse than delayed parity. **Codex is a deliberate fast-follow** — a later spec that
  builds + dogfoods a codex orchestration adapter (full pipeline through all 4 gates + ≥1 BLOCK/retry + Phase-5 scaffold;
  sequential fan-out is an honest degrade, but **skipping judge batches or weakening gates is NOT**). Recorded so it is
  not lost, not a v1 blocker.
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
- **D3 — it is a SKILL-PAYLOAD plugin (no new engine) that DEPENDS on the `agent-browser` plugin for the visual check
  (owner insight 2026-06-29) — it does NOT reinvent browser machinery.** `product-foundation` materializes a skill block
  (`blocks: {claude}` per D1), bundling the pipeline templates + references + the Apache-2.0 Open-Design `design-systems/`
  vendor tree + the TS scripts. It provisions NO external tools of its own. The best-effort Phase-4 visual check (sweep
  the hi-fi mood screens over `file://`, screenshot 375/1280, probe horizontal overflow) is driven through the **existing
  `agent-browser` plugin** (v2.1.x — pinned checksum-verified CLI + the runtime-neutral navigate/snapshot/screenshot/
  extract skill), declared as a **spec-276 plugin dependency** (`dependencies: ["agent-browser@^2.1.0"]`) — exactly the
  pattern `visual-qa` already uses. Per spec 276 this is **declared + surfaced in the drawer's REQUIRES section (✓/⚠
  missing), NON-BLOCKING, no auto-install/cascade** — so it does NOT bloat the core install with Chrome+CLI, and the
  visual check **degrades gracefully to a recorded skip** when agent-browser (or Chrome, or the route ≠ primary) is
  absent — the source's fail-closed/never-block posture (spec 153), now expressed as a plugin dep instead of a host
  primitive. (`visual-qa` is prior art but is real-URL / worktree-merge-advisory oriented; product-foundation depends on
  `agent-browser` DIRECTLY for its `file://` hi-fi mood sweep.) Confirm "no new engine" holds (the design-system bundle +
  scripts are the only weight) during the build.
- **D4 — zero Agent0 references (public-surface hygiene).** The plugin (manifest + skill + templates + references +
  vendor bundle + README) is self-contained in `tachyon-plugins/product-foundation/` and names no Agent0 path/skill;
  the SDD handoff targets the `sdd` plugin generically.
- **D5 — PAID/EXTERNAL safety.** The pipeline makes no paid calls and no network calls of its own (unlike the fal media
  plugins); the only external surface is the depended-on `agent-browser` plugin for the best-effort visual check (D3),
  which is itself free/local (host Chrome). The headless dogfood runs the pipeline shape (or a representative slice) with
  no paid dependency and treats agent-browser as optional (skip-when-absent).

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
(`product-foundation`), shipping **claude-only in v1** (codex a fast-follow, D1), and reusing the existing
`agent-browser` plugin (a spec-276 dependency) for the best-effort visual check instead of reinventing it (D3).

## Acceptance criteria

- [x] **Scenario: installs as a skill plugin**
  - **Given** the `product-foundation` plugin in `tachyon-plugins/`
  - **When** it is installed via the engine into a workspace
  - **Then** the pipeline skill block materializes for each declared runtime (no MCP block, no new engine), the lockfile
    records the skill, and there are zero Agent0 references in the shipped tree
- [x] **Scenario: the pipeline runs through its state machine**
  - **Given** an installed `product-foundation` and a one-line idea
  - **When** the pipeline runs (headless dogfood, full shape or a representative slice)
  - **Then** it advances phase/step through `.state.json`, enforces the concept kill-gate + phase gates, and produces the
    docs-first foundation tree + the visual contract + the SDD handoff scaffold
- [x] **Scenario: the dead MCP invariants survive the strip (D2)**
  - **Given** the stripped plugin (no `product_step_submit` / `schema-incomplete` / "MCP regex-extracts" prose)
  - **When** a step submits an artifact that violates a schema floor (missing required heading / under `min_size` /
    missing a `contains` token / an incomplete multi-file bundle / a missing `validation_mode:` line)
  - **Then** the plugin-native validator REJECTS it with a precise schema-incomplete-style failure (which step/file/field),
    does NOT advance `.state.json`, and the `validation_mode:` field is still extracted into state for the roadmap to read
- [x] **Scenario: v1 ships claude-only (D1)**
  - **Given** the resolved runtime ruling (codex sub-agent delegation is convention-only → not native orchestration)
  - **When** v1 is packaged
  - **Then** the manifest declares `runtimes: ["claude"]` / `blocks: {claude}`, and the codex port is recorded as a
    fast-follow (its own later spec — full-pipeline codex dogfood through all 4 gates + ≥1 BLOCK/retry + Phase-5 scaffold;
    never a hollow port, no degrade that skips judge batches or weakens a gate)
- [x] **Scenario: the visual check reuses the agent-browser plugin (D3)**
  - **Given** the manifest declares `dependencies: ["agent-browser@^2.1.0"]` (spec 276) and bundles NO browser machinery
  - **When** the plugin is installed
  - **Then** the drawer's REQUIRES section surfaces agent-browser (✓ satisfied / ⚠ missing), the install is NON-BLOCKING
    (no auto-install/cascade), and the Phase-4 visual check drives the agent-browser plugin when present OR records a
    skip when it (or Chrome / the route) is absent — never blocking, never reinventing the browser primitive
- [x] product-form awareness preserved (screen-app / headless-service / cli / bot / embedded adapt the relevant steps)
- [x] the Open-Design `design-systems/` vendor bundle ships with its Apache-2.0 LICENSE/NOTICE intact
- [x] both codex duetos (design — this; impl — post-build) folded; headless dogfood green; spec closed with a `**Closure:**`
- [x] NO new engine (skill-payload plugin only); the visual check depends on the `agent-browser` plugin (spec 276), degrades-to-skip when absent

## Non-goals

- Generating a runnable app (the pipeline is docs-first; the app build is the SDD workflow on the scaffolded specs).
- Re-introducing any MCP (the `mcp-product-pipeline` architecture is dead and not revived; D2).
- `frontend-designer` (a separate, UI-acceptance-gated migration) and `brainstorm` (dropped 2026-06-29).
- Changing the pipeline's substance (the 15 steps / gates / judge protocol are migrated, not redesigned) beyond the MCP
  strip + re-home and the runtime adapter.

## Open questions

- **OQ1 — codex native orchestration.** RESOLVED 2026-06-29 → **v1 is claude-only** (D1). Codex sub-agent delegation is
  convention-only (no native enforced 5-field-brief dispatch), which is the pipeline's spine → by the owner's rule, codex
  is a deliberate FAST-FOLLOW (its own later spec: build + dogfood a codex orchestration adapter), not a v1 blocker.
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

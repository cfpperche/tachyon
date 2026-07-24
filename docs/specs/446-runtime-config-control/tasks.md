# 446 — runtime-config-control — tasks

_Generated from `plan.md` on 2026-07-24. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Slice A: establish typed runtime-config inventory/read boundary and replace static prototype
      with a live read-only Codex Global/Workspace view. No native writes.
- [x] Slice B: extend the canonical SDD 442 adapter with one-panel atomic Codex scalar/MCP editing
      that detects external source changes, preserves unowned data and reversibly comments MCP blocks.
- [ ] Slice C: mark only affected running agents configuration-pending and acknowledge the change
      through successful Start/Restart/Resume materialization.
- [ ] Slice D: measure and add Claude/Grok adapters independently; update parity evidence.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Global/workspace provenance and individual tooling inventory are rendered from real source
      inputs, not fixture data.
- [x] Known writes preserve unrelated keys and fail closed for malformed/unsafe sources.
- [ ] A running affected agent remains live but is visibly pending until its next successful launch.
- [ ] Existing canonical private-home and auth boundaries remain unchanged.

**Verify:** `npx vitest run test/unit/runtimeConfig*.test.ts test/unit/cockpit.test.ts test/unit/cockpitRoute.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** runtime source files and installed CLI launch paths require the human Dev Host
review; the beta headless harness is intentionally not used for this surface.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** open the Dev Host fixture; inspect Codex Global and Workspace sources, change one
measured entry, verify affected-agent pending state, then Stop + Resume that agent and confirm the
pending marker clears.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [ ] Evidence: installed Dev Host screenshots for Codex Global and Workspace views.
- [ ] Verdict:

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <446>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** the visual Control flow is self-describing and this spec adds no standalone
operator command or Bridge API.

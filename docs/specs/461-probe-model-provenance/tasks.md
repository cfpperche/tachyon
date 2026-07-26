# 461 — probe-model-provenance — tasks

_Generated from `plan.md` on 2026-07-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add requested-model and reported-model provenance without inference.
- [x] Parse Claude's reported model usage and preserve it under runtime-native evidence.
- [x] Cover invocation, successful reported provenance, omitted provenance and persistent metadata.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Run focused adapter, service and store tests.
- [x] Run configured typecheck and full verification.

**Headless check:** `npx vitest run test/unit/probeAdapterClaude.test.ts test/unit/probeService.test.ts test/unit/probeStore.test.ts`
**Verify:** `npx vitest run test/unit/probeAdapterClaude.test.ts test/unit/probeService.test.ts test/unit/probeStore.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** A real probe would consume provider quota; focused fixtures exercise the structured provenance boundary.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Run a Claude probe requesting `claude-opus-5` and inspect requested versus reported provenance.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** No rendered surface changes; the Probes table is outside this slice.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <461>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

<!-- **Cookbook:** yes -->
**Cookbook-Opt-Out:** Existing `probe_agent` API gains provenance only; no new operator workflow.

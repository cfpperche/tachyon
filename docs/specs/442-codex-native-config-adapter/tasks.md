# 442 — codex-native-config-adapter — tasks

_Generated from `plan.md` on 2026-07-23. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Slice A: typed agent selector projection and exact support declaration.
- [x] Slice B: reviewed global/workspace scalar-family parser and allowlist.
- [ ] Slice C: tooling composition is split by trust boundary: private composition of existing
      captured capabilities with native scalar projection (`t-2b258a`), source discovery and
      capture contract (`t-c9a086`), then Agent Studio source/effective controls (`t-115742`).
      Native extensions remain unsupported until their agent-scoped mechanism is measured.
- [ ] Slice D: lifecycle dogfood and per-family parity evidence.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Omitted policy remains byte-compatible with current canonical behavior.
- [x] Supported-only selectors project exact values.
- [x] Unsupported/mixed tuples write nothing and name the rejected tuple.
- [x] Auth remains external and source state/credentials never enter generated config.
- [ ] Fresh/restart/resume regenerate equivalent projection.

**Verify:** `npx vitest run test/unit/codexNativeConfigProjection.test.ts test/unit/agentNativeConfigPolicy.test.ts test/unit/agentProfileConfigLoader.test.ts test/unit/harness.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** declared after Slice D; earlier slices use focused projection/materialization tests and do not claim installed lifecycle parity.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** after Slice D, create a new canonical Codex agent with explicit selectors and compare fresh/restart/resume behavior in the installed extension.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** no editing surface changes before installed Slice D dogfood.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <442>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** policy is operated through Agent Studio and canonical profiles; no new standalone command.

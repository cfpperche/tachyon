# 451 — pi-canonical-exact-trust — tasks

_Generated from `plan.md` on 2026-07-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add exact Pi trust publication without changing ordinary seed semantics.
- [x] Route plain and captured-capability canonical Pi homes through exact mode with effective cwd.
- [x] Add direct writer and fresh/restart/resume regression coverage.
- [x] Run real Pi TTY dogfood and update the parity matrix only after it passes.
- [x] Record closure evidence and run the SDD closure audit.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Focused Pi harness and AgentManager tests pass.
- [x] `npm run typecheck` passes.
- [x] `npm run verify:full:quiet` passes on the integrated commit.

**Headless check:** `npx vitest run test/unit/harness.test.ts test/unit/agentManager.test.ts -t "canonical Pi|Pi gets regular private"`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** Pi's trust prompt is TTY-only; the real interactive disposable-home dogfood is recorded in `notes.md`.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Launch Pi 0.80.10 offline in a disposable trust-gated project using the
materialized canonical private home; confirm it enters the normal TUI without answering a trust
prompt, then exit without model interaction.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** No product UI changes; the native TTY prompt behavior is covered by dogfood.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <451>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** Internal materialization invariant; no new operator surface.

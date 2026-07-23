# 436 — canonical-profile-forget — tasks

_Generated from `plan.md` on 2026-07-22. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Implement the durable forget journal, exact snapshots, normalized lock, admission query, and one-way recovery state machine.
- [x] Add exact authority/config convergence and manifest-qualified canonical-home quarantine.
- [x] Wire startup recovery, spawn blocking, and profile-aware delete routing without invoking broad legacy cleanup.
- [x] Add focused transaction and Workspace regression coverage, including crashes, lost acknowledgements, live refusal, custody mismatch, preservation, and name reuse.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Focused transaction and Workspace tests pass.
- [x] Full repository verification and typecheck pass.

**Headless check:** `npx vitest run test/unit/agentProfileForget.test.ts test/unit/workspaceHeadless.test.ts`
**Verify:** `npm run verify:full:quiet`
**Verify:** `npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npx vitest run test/unit/agentProfileForget.test.ts test/unit/workspaceHeadless.test.ts`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** internal lifecycle transaction; no rendered surface changes.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <436>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** existing Remove action is unchanged; no new operator surface.

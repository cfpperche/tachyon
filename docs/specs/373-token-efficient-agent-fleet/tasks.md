# 373 — token-efficient-agent-fleet — tasks

_Generated from `plan.md` on 2026-07-11. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [ ] Wait for spec 372 to land cleanly; confirm `npm run verify:full:quiet` and the workspace full-gate default exist.
- [ ] Preflight the four exact runtime/model commands and record their supported model/readiness evidence.
- [ ] Update the declared fleet: keep coordinator Sol xhigh, change executor to Terra medium, add Luna-low mechanical
  executor, and change reviewer to Claude Sonnet with the correct owned-subagent relationships.
- [ ] Encode closed routing rules, two-checkpoint full-gate cadence, one-batch coordinator audit, and context lifecycle
  in the durable role instructions without weakening delivery isolation or review scope.
- [ ] Add focused regression tests for declared commands, role composition/re-anchor, and the restart-versus-resume
  distinction; add lifecycle production changes only if those tests expose a real gap.
- [ ] At a safe task boundary, checkpoint active agent state, reload config, restart affected declared agents into
  fresh conversations, re-anchor, and confirm session/model/readiness before routing new work.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] Config parsing exposes Sol xhigh, Terra medium, Luna low, and Claude Sonnet exactly, with no fallback command.
- [ ] Focused tests prove the seven-point policy survives primer composition and restart/re-anchor.
- [ ] Focused lifecycle tests prove restart mints fresh context and resume retains existing context/worktree semantics.
- [ ] Dogfood records one closed Terra implementation route, one Luna mechanical route, one Claude review route, and
  the two-checkpoint full-gate journal without extra unreasoned full runs.
- [ ] Run `npm run verify:full:quiet` on the first reviewable candidate and again on the final accepted head; use only
  focused tests, typecheck, and diff-check between those checkpoints.

**Headless check:** `npm run typecheck && npm run test:diff-check && npm run verify:full:quiet`
**Verify:** `npm run typecheck`
**Verify:** `npm run test:diff-check`
**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npm run verify:full:quiet`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** after spec 372 finishes, reload `tachyon.yml`; restart `codex-executor` and `codex-reviewer`, start
`codex-mechanical`, then inspect the Activity/runtime headers to confirm Terra medium, Claude Sonnet, and Luna low in
fresh sessions before assigning bounded smoke contracts.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

**Visual QA Opt-Out:** no visual design changes; runtime/model/session identity is verified structurally and by
launch dogfood.

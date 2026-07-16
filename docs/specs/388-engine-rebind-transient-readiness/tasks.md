# 388 — engine-rebind-transient-readiness — tasks

_Generated from `plan.md` on 2026-07-16. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [ ] Add RED AgentManager tests for an unchanged cached `false`, a fresh `ready`, and immediate
  Delivery/snapshot denial without transcript resolution.
- [ ] Add RED coordinator tests for `retry -> ready`, bounded timeout, same-session resume, audit
  transitions, and zero teardown before readiness.
- [ ] Add the uncached typed AgentManager rebind probe while preserving the existing cached boolean API.
- [ ] Implement bounded coordinator polling with fresh ledger/liveness/generation/authority checks.
- [ ] Wire Workspace to the new probe and update stale host-reload terminology to engine incarnation.
- [ ] Extend persistent-engine dogfood to compare Bridge generation and rebind audit across shell
  detach/reattach.

## Verification

- [ ] Transient readiness test proves wait -> ready -> one stop/resume -> `resume_ok`, using the same
  session identifier and no cold spawn seam.
- [ ] Timeout and permanent-denial tests prove the original process remains alive with no teardown.
- [ ] Cache test proves the recovery probe is fresh without weakening ordinary cached reads.
- [ ] Persistent-engine boundary tests and dogfood prove shell reattach leaves generation/audit unchanged.
- [ ] Existing rebind, AgentManager, engine-boundary suites and typecheck remain green.

**Headless check:** `npx vitest run test/unit/bridgeClientRebind.test.ts test/unit/agentManager.test.ts test/unit/engineProcessBoundary.test.ts test/unit/engineSupervisor.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

**Verify:** `npx vitest run test/unit/bridgeClientRebind.test.ts test/unit/agentManager.test.ts test/unit/engineProcessBoundary.test.ts test/unit/engineSupervisor.test.ts && npm run typecheck`

## Dogfood

**Dogfood:** `node scripts/dogfood/persistent-engine.mjs`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** On the next installed engine upgrade with a young Codex survivor, confirm the daemon
rebind audit records a bounded readiness wait followed by `preflight_ok`/`resume_ok`, with no manual
Stop -> Resume.  This is optional and does not replace the deterministic headless regression.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

**Visual QA Opt-Out:** no visual surface changes; evidence is lifecycle state and append-only audit.

# 317 — persistence-hook-failure-log — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Draft plan.md after owner ratifies this child spec's position in the sequence.
- [x] Generate implementation tasks from the approved plan.
- [x] Add a persistence hook failure ledger path helper.
- [x] Pass the failure ledger path into materialized Claude and Codex hook commands when silent persistence is active.
- [x] Make materialized hook scripts append sanitized failure rows on catch paths.
- [x] Keep logging failures best-effort so hook scripts still do not block the runtime.
- [x] Add focused tests for schema, command wiring, syntax validity, and failure swallowing.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] `sessionOwners` unit tests cover failure log schema/wiring.
- [x] `harness` unit tests cover materialized script presence/path wiring.
- [x] Typecheck passes.

**Verify:** `npm test -- test/unit/sessionOwners.test.ts test/unit/harness.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** This spec is hook-script failure plumbing; the representative proof is deterministic unit execution of the materialized scripts and wiring. Real runtime failure dogfood belongs in spec 315 after the failure ledger exists.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

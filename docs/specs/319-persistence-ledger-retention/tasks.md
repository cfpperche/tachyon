# 319 — persistence-ledger-retention — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Draft plan.md after failure-log schema and handoff-candidate data needs are known.
- [x] Generate implementation tasks from the approved plan.
- [x] Add host-side persistence ledger retention helper.
- [x] Embed standalone retention in materialized persistence hook scripts.
- [x] Prune `persistence-stop.jsonl` after Stop hook append.
- [x] Prune `persistence-hooks-failures.jsonl` after failure append.
- [x] Preserve recent rows and newest row per `agent/event/script` within hard row/byte caps.
- [x] Write compacted ledgers through temp-file plus rename.
- [x] Drop malformed/partial lines only during retention.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Unit test covers pruning old Stop rows while keeping newest per key.
- [x] Unit test covers malformed/corrupt line tolerance.
- [x] Unit test covers byte-cap enforcement with multi-byte content.
- [x] Unit test covers Stop recorder invoking retention after append.
- [x] Typecheck passes.

**Verify:** `npm test -- test/unit/sessionOwners.test.ts test/unit/harness.test.ts && npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** Retention is deterministic file maintenance inside hook scripts; unit tests execute the real materialized Stop recorder source against an oversized ledger and verify pruning. Human runtime dogfood would only duplicate that file-level behavior.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

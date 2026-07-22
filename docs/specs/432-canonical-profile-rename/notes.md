# 432 — canonical-profile-rename — notes

_Created 2026-07-22._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Profile authority compare-and-move is the only irreversible commit point. Every earlier state compensates; every later state rolls forward.
- Evolution remains authoritative for its own state. The outer transaction records only `profileId` and completion state, never copies its authority head.
- The architecture review is recorded at `/home/goat/tachyon/.tachyon/probes/probe-062ec3c9-c081-47e9-8043-3888e7fde595/result.json`. Adopted findings: one-write authority move, full home manifest, semantic YAML pair states, normalized ordered locks, and authority-validated Evolution replay.

## Deviations

- Evolution now resides inside `.tachyon/agents/<name>/evolution`. The home move therefore leaves that subtree temporarily at the source name and delegates its owner/authority rewrite to `EvolutionStore.renameAgent`; moving it blindly produced invalid name-bound bytes.

## Tradeoffs

- V1 does not add a second authenticated reservation index or process-instance nonce. Existing lifecycle custody remains single-workspace/cooperative-process scoped; malformed journals fail closed, and exact tree/authority/YAML states prevent unsafe automatic mutation.

## Open questions

None.

## Verification

- `npx vitest run test/unit/agentProfileRename.test.ts test/unit/agentProfileLifecycle.test.ts test/unit/agentProfileMigration.test.ts test/unit/workspaceHeadless.test.ts` — 100 passed.
- `npm run verify:full:quiet` — 474 files passed; 5422 tests passed, 3 skipped.
- `npm run typecheck` — passed.

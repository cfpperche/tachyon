# 433 — Live canonical profile rename — notes

_Created 2026-07-22._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Extend the existing rename transaction rather than introduce a second journal.
- Durable evidence is tmux name ownership, the exact ledger row/graph and activity source/target pair state. Editor tabs and in-memory indexes are rederived after commit.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Activity digests captured at intent cannot remain exact while a running agent emits events. Destination absence plus source/target pair state establishes custody; current source bytes are moved so late appends are preserved.

## Open questions

None.

## Verification

- Focused live/profile/ledger/activity/Workspace suite — 569 tests passed.
- `npm run verify:full:quiet` — 474 files passed; 5428 tests passed, 3 skipped.
- `npm run typecheck` — passed.

## Verification log

### 2026-07-22T23:27:49Z — pass (2/2) — source: tasks.md
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass

## Dogfood log

### 2026-07-22T23:29:43Z — pass (1/1) — source: tasks.md — commit: 599441cce131a745a9aa61ebd44385f034abf5ff
- `npx vitest run test/unit/logStore.test.ts test/unit/resume.test.ts test/unit/agentManager.test.ts test/unit/agentProfileRename.test.ts test/unit/workspaceHeadless.test.ts` — pass

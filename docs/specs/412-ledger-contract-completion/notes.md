# 412 — ledger-contract-completion — notes

_Created 2026-07-19._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- The persisted invalid marker records only a closed reason and never retains or echoes task,
  context, constraints or completion text.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- A later write of any ledger row sanitizes the malformed contract body away. The closed invalid
  marker is persisted in its place so subsequent reloads remain fail-closed without retaining
  sensitive or misleading free-form bytes.

## Open questions

None.

## Verification evidence

- Focused `spawnContract` + `SessionLedger` + `AgentManager` suite: PASS, 3 files / 518 tests.
- `npm run test:invariants`: PASS, PI-001 2/2.
- `npm run typecheck`: PASS.
- `npm run verify:full:quiet`: PASS, 437 files / 5,033 passed / 3 skipped (5,036 total).

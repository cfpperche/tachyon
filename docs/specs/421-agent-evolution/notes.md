# 421 — agent-evolution — notes

_Created 2026-07-21._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-21 — The maintainer directed all remaining SDD 421 work to stay in one isolated managed
  worktree. Tachyon created
  `/home/goat/.cache/tachyon/worktrees/b349073a/change/agent-evolution` on
  `tachyon/change/agent-evolution` from spec commit `ea6b50df`.
- 2026-07-21 — The maintainer approved the architecture in `plan.md` without changes. The spec moved
  to `in-progress`; implementation will follow the five sequential slices in `tasks.md`.
- 2026-07-21 — Mission Control decomposition: umbrella `t-6c351f`; Slice 1 `t-87cc14`; Slice 2
  `t-fc8279`; Slice 3 `t-0fa8ba`; Slice 4 `t-cec393`; Slice 5 `t-6218bf`. Dependencies enforce the
  approved delivery order.
- 2026-07-21 — Task completion reviews live under `evolution/reviews/`. The Task write commits first;
  review creation, notice delivery and Studio refresh are best-effort observers that cannot revert it.
- 2026-07-21 — A review is bound to the Bridge-resolved agent and one completion revision. Identical
  replay returns the original result; different replay, wrong-agent access and failed reviews reject.
- 2026-07-21 — The session ledger keeps the complete immutable Evolution snapshot, in addition to its
  version/digest. Resume and rebind need no reinjection; fork and re-anchor can reuse the exact old
  content even after a human approves a newer active version.
- 2026-07-21 — A fresh restart resolves the current canonical profile again. Changing only `cmd`
  therefore changes the executor while preserving the same profile identity, version and snapshot.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Architecture validation

- 2026-07-21 — `git diff --check` passed; SDD ids are unique; no scaffold placeholders remain.
- 2026-07-21 — `npm run verify:full:quiet` passed: 457 files, 5,180 tests passed and 3 skipped.
- 2026-07-21 — `npm run typecheck` passed.

## Slice 1 validation

- 2026-07-21 — Focused config/schema/YAML/Studio/protocol/EvolutionStore coverage passed: 220 tests.
- 2026-07-21 — `npm run verify:full:quiet` passed: 458 files, 5,192 tests passed and 3 skipped.
- 2026-07-21 — `npm run typecheck` passed after the final Slice 1 changes.

## Slice 2 validation

- 2026-07-21 — Focused TaskStore, EvolutionStore, Coordinator, Bridge, auth and engine coverage passed:
  129 tests across the directly affected suites.
- 2026-07-21 — `npm run verify:full:quiet` passed: 460 files, 5,202 tests passed and 3 skipped.
- 2026-07-21 — `npm run typecheck` passed after the final Slice 2 changes.

## Slice 3 validation

- 2026-07-21 — Focused promotion, prompt, startup inventory, ledger, AgentManager, fork, re-anchor and
  Workspace coverage passed: 554 tests across the directly affected suites.
- 2026-07-21 — `npm run test:invariants` passed: PI-001's existing promise/oracle and evidence mechanics
  were unchanged, so no independent mechanics-equivalence review was triggered.
- 2026-07-21 — `npm run verify:full:quiet` passed: 461 files, 5,210 tests passed and 3 skipped.
- 2026-07-21 — `npm run typecheck` passed after the final Slice 3 changes.

# 376 — retire-legacy-delivery — notes

_Created 2026-07-13._

## Planning baseline — 2026-07-13

- Maintainer direction: remove the legacy delivery lifecycle completely and make the new canonical mechanism the
  only product path; do not finish spec 368 and do not add unrelated functionality.
- Board task: `t-85f251` (inbox at planning time), linked to this spec and spec 368 only as a relation.
- Repository HEAD at planning time: `0299cc6d` (`0.56.1`); `main` matched `origin/main`.
- Unrelated untracked `docs/business/` existed before this spec and is explicitly out of scope.
- Current workspace state, read-only snapshot:
  - 101 `.tachyon/delegations/*.json` records;
  - 100 GitDelivery SQLite rows: 4 linked, 96 unlinked, 74 active-unlinked;
  - 4 canonical Delivery rows, all linked: 1 free, 2 held, 1 quarantined;
  - no old `.tachyon/deliveries{,.migrated-v1}` JSON records.
- The migration decision is archive-and-retire metadata, never import historical records and never mutate Git.
- GitDelivery is retained only as a linked Git projection. The retired system is the standalone/Delivery-less
  lifecycle, not the projection vocabulary.
- Process-fenced work remains unreachable and outside this spec. The product path is mechanism-only; no remaining
  368 acceptance criterion is pulled into this closure.

## Existing-work correlation — 2026-07-13

- The initial plan linked spec 368 but did not systematically correlate the existing board tasks.
- `t-c91486` is the direct predecessor and is superseded by `t-85f251`; its safe preview/archive requirements are
  retained, while its wait-for-368/deprecation-window sequencing is replaced by the maintainer's hard-cut decision.
- `t-0de165` is made obsolete by removing `reuse_worktree` rather than repairing that compatibility path.
- Completed dogfood `t-dc5d94` is baseline evidence only; spec 376 still requires a fresh installed post-cut dogfood.
- Cleanup tasks `t-e7a032`/`t-2a2af8` and residual 368 hardening tasks remain independent and non-blocking.
- The exact T16–T20 overlap and the regression obligations from `t-7acc58` and `t-aa9b77` are recorded in
  `plan.md`; no unchecked spec 368 task is implicitly claimed complete.

## Deviations

None yet.

## Tradeoffs

The hard cut intentionally gives up runtime compatibility with unretired legacy metadata. In exchange, the code
and API—not coordinator memory—guarantee one lifecycle. The explicit raw archive preserves audit/recovery value
without keeping the old system executable.

## Open questions

None at planning time.

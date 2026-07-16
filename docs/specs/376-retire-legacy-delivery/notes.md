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

## Implementation candidate — 2026-07-16

- Isolated worktree: `/home/goat/tachyon-worktrees/t-85f251`.
- Branch: `codex/t-85f251-retire-legacy-delivery-r2`, based on `274c8b22`; `main` was not modified or merged.
- The candidate removes the old models and public entry points, makes gated spawn/join/verify canonical-only,
  keeps GitDelivery as an immutable linked projection, and adds the explicit preview/archive/retire operation.
- The retirement fixture contains canonical plus legacy metadata, linked and unlinked projections, clean and
  dirty worktrees, and snapshots all refs, HEADs, statuses, and worktree registrations before and after apply.
- A preview was run against a temporary copy of the current real workspace metadata. It found 101 delegation
  files, 101 unlinked GitDelivery rows, 126 old mirror files, 25 canonical Deliveries, and 25 linked projections
  (330 retirement entries total). The copy's complete file inventory and hashes were unchanged by preview.
- Focused matrix: 21 files / 886 tests passed. Additional retirement, Workspace, auth, and store corrections
  passed their focused reruns. `npm run typecheck`, `npm run build`, and `git diff --check` passed.
- The first global candidate run exposed two obsolete test contracts (the old Bridge tool count and automatic
  JSON-store promotion) plus missing generated engine bundle artifacts. The tests were corrected to assert the
  canonical-only contract, the bundle was built, and the repeated global gate passed: 403 files, 4,626 tests,
  3 skipped.
- The final current-source audit found no old public lifecycle symbol outside the deliberate removed-setting
  diagnostic and durable mechanism-only evidence vocabulary.
- Still required before merge: independent immutable review, installed-extension retirement/happy-path dogfood,
  any consolidated corrections those produce, push, and explicit maintainer acceptance.

## Deviations

- At the maintainer's direction, implementation was performed directly in a separate worktree without using the
  Delivery mechanism, without subagents, and without automatic integration.
- The current session primer defines the global full gate as `npm test`; typecheck, build, and diff-check were run
  separately. This replaces the older `npm run verify:full:quiet` wording in the generated task artifact.

## Tradeoffs

The hard cut intentionally gives up runtime compatibility with unretired legacy metadata. In exchange, the code
and API—not coordinator memory—guarantee one lifecycle. The explicit raw archive preserves audit/recovery value
without keeping the old system executable.

## Open questions

None at planning time.

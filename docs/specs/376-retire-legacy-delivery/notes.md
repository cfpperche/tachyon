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
- Branch: `codex/t-85f251-retire-legacy-delivery-r2`. The first candidate was cut from `274c8b22`; after its
  local audit it was rebased onto current `main` at `fe83adf9`. `main` was not modified or merged. The pre-rebase
  candidate remains recoverable at `backup/t-85f251-pre-main-rebase-384fe70c`.
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
- The current-main audit preserved the parallel lease-salvage path, restart/rebind work, gated-preparation error
  diagnostics, and Mermaid viewport changes. Normal handoff remains unconditionally `mechanism-only`; the process
  fence is an optional, recovery-only proof source, and salvage still fails closed to a bound human approval when
  that proof is unavailable. The combined Bridge surface is 62 tools: canonical-only removes standalone open while
  salvage remains available.
- Rebase forcing passed on 7 files / 638 tests, followed by `npm run typecheck`. The first combined `npm test`
  exposed two stale assertions already present in the incoming main: a multiline ESM import detached its
  `@ts-expect-error`, and the git-hook wrapper test still expected a direct launcher `exec` after main added a
  worktree fallback. Both were corrected without production behavior changes. The final combined gate passed:
  406 files, 4,676 tests, 3 skipped; `git diff --check` and the legacy-symbol source audit were clean.
- Still required before merge: independent immutable review, installed-extension retirement/happy-path dogfood,
  any consolidated corrections those produce, push, and explicit maintainer acceptance.

## Immutable review R1 and consolidated correction — 2026-07-16

- Review artifact: `.tachyon/reviews/376-retire-legacy-delivery-r1.md` against the immutable pre-correction
  candidate. It found two blocking composition defects: canonical open replay accepted mismatched immutable
  projection authority, and canonical prune did not carry spec 392's managed-worktree removal seam.
- The correction centralizes exact immutable-open matching in `GitDeliveryStore` (workspace, creator, Delivery,
  agent, branch, canonical path, Tachyon branch ownership, and base), repeats the receipt check at the projection
  boundary, and deliberately leaves only the branch head mutable for sequenced replay.
- Both normal and reconciled canonical prune now call the injected managed removal seam. Workspace wires that seam
  to `ManagedWorktreeService.removePath`, so successful removal updates the registry while occupancy remains
  fail-closed. The gated-spawn receipt now also verifies workspace, branch ownership, and base.
- Regression evidence: the three directly affected suites pass 41/41; the combined GitDelivery, projection,
  generated projection behavior, managed-worktree, auth, Bridge, AgentManager, and headless Workspace matrix passes
  527/527. `npm run typecheck`, `npm run build`, and `git diff --check` pass.
- The combined matrix also exposed two stale current-main fixtures: one still supplied the deleted
  `recordDelegation` callback, and one expected parented ad-hoc `cwd` to be accepted despite the newer fail-closed
  contract. Only those test expectations were corrected; no extra production behavior was changed.
- The first post-correction global gate exposed one stale generated error matcher and one real current-main
  composition regression: the new Bridge-wiring guard classified a declared non-AI `sh` command as an AI runtime
  and refused the daemon's valid agent start. The guard now applies only to recognized AI adapters; the new
  non-AI regression plus the generated conflict matcher and daemon service pass 354/354 focused tests.
- R1 blockers are locally corrected. Immutable re-review, final `npm test`, installed dogfood, push, and explicit
  maintainer acceptance remain required; nothing has been merged or installed.

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

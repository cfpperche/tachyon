# 444 — worktree-registry-hygiene — notes

_Created 2026-07-23._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- **The classifier emits 4 algorithmic states, not 5.** spec.md/the task's own scope line list "active
  checkout" alongside `record-only`/`ready-to-remove`/`needs-review`/`occupied` as UI display groups.
  Algorithmically, once a checkout is real (path exists), it is always exactly one of
  occupied/ready-to-remove/needs-review — there's no fifth decidable state distinct from those three
  that "active" could mean without just being a synonym for one of them. Resolution: `classify.ts`
  returns exactly `record-only | ready-to-remove | needs-review | occupied`; the pre-existing registry
  `status` field (`active | abandoned`, spec 392, unchanged) is shown alongside as a second, orthogonal
  axis — a row can be registry-status `active` and classifier-verdict `needs-review: dirty` at the same
  time, which is exactly this workspace's real `session-continuation-*` example. Not going back to the
  maintainer for this one: it's a reasonable reading of an enumeration list, not a genuine fork with two
  materially different outcomes.
- **`aheadOfBase === 0` (via `WorktreeManager.status()`'s existing `rev-list --count baseRef..HEAD`) is
  the primary containment signal**, with a ported `git cherry baseRef HEAD` patch-equivalence check
  (mirroring `git-delivery/classify.ts`'s `patchesAllInBase`) only as the fallback when `aheadOfBase >
  0` — avoids a redundant `merge-base --is-ancestor` call in the common case, since `aheadOfBase === 0`
  is mathematically equivalent to "HEAD is an ancestor of (or equal to) baseRef".

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- **2026-07-24 — process boundary forces an RPC layer the plan missed.** The plan assumed
  `CockpitDeps.collect()` (extension host) could call `ManagedWorktreeService.listClassified()`
  in-process. It can't: the service lives in the persistent engine, a separate process (SDD 382).
  That same boundary is why `disk.ts`'s raw reader existed at all — checked its provenance when the
  maintainer challenged the "workaround" label: born in POC commit `656f6393`, zero test references
  anywhere in `test/`, lenient parallel parser bypassing `loadManagedWorktreeStore`'s fail-closed
  validation, `catch {} → []` (read failure indistinguishable from genuinely empty). Plan revised:
  new engine RPC query `worktrees.classified` + commands `worktree.forget-record` /
  `worktree.remove-managed`; `readManagedWorktreesFromDisk` deleted once consumer-free.
- **2026-07-24 — fallback hardened beyond the original plan (maintainer-ratified).** The plan kept
  the raw reader as a degraded fallback. Ratified instead: engine unreachable → honest error state
  in the tab, never unverified rows ("dado não-confiável não é melhor que dado nenhum"). The same
  debt in `readGitDeliveriesFromDisk` (Deliveries tab) is out of scope and tracked as t-43c6fa.

- **2026-07-24 — adversarial-review BLOCKER: unresolvable baseRef read as "contained".**
  Reviewer confirmed (with the exact mechanism) a suspicion raised pre-review: `WorktreeManager.
  status()` best-effort-coerces a failed `rev-list baseRef..HEAD` to `aheadOfBase: 0` and RESOLVES
  — it never rejects for that failure mode — so classify.ts's rejection-only sentinel was dead code
  and a deleted/gc'd/typo'd baseRef (spec 392's `register()` never validated it) classified a
  worktree of unknown ancestry `ready-to-remove`. Worse: containment was only ever computed at
  render time; `remove()` re-checks occupancy + uncommitted-dirt but not ancestry. Fixed in three
  layers: (1) `WorktreeStatus.aheadProbeFailed` (additive optional field) distinguishes "0 ahead"
  from "probe failed"; (2) classify.ts fails closed on it with a specific reason; (3) new
  `ManagedWorktreeService.removeClassified()` re-runs the FULL classifier at execution time and is
  what the `worktree.remove-managed` RPC now calls — all three safety signals re-validated at the
  point of deletion. Tests re-pinned to the REAL non-throwing shape (unit + real-git with a
  corrupted baseRef + PI-002 second case); the original throwing-mock case kept for the genuine
  rejection path. PI gate: 2 invariants, 4 tests. Residual (recorded, not fixed here): `register()`
  still accepts an unvalidated baseRef — now harmless for cleanup (classification fails closed) but
  worth a validation at registration; folded into the spec's future-work rather than a new task.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

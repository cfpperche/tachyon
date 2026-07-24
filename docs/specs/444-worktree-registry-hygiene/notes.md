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

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

# 444 — worktree-registry-hygiene — plan

_Drafted from `spec.md` on 2026-07-24._

## Approach

Add one new engine-side module, `src/worktree/classify.ts` (mirroring `src/git-delivery/classify.ts`'s
shape), exporting `classifyManagedWorktree(entry, deps): Promise<WorktreeClassification>` that composes
existing fail-closed primitives (path existence, `WorktreeManager.status` for dirty/ahead,
`AgentManager.worktreeOccupant` for occupancy, `tachyonCreatedBranch` for ownership, a small ported
ancestry check for containment) into one of five states: `active` (real checkout, healthy),
`record-only` (tombstone — path gone), `ready-to-remove` (real, clean, unoccupied, contained,
zero unique commits), `needs-review` (real, blocked by a stated reason: dirty / unique-commits /
unknown-ancestry / non-owned-branch), `occupied` (real, blocked specifically by a live agent).

**REVISED 2026-07-24 mid-implementation (see notes.md § Deviations):** `src/extension.ts` (Extension
Host shell) and the persistent engine (where `ManagedWorktreeService` lives) are SEPARATE PROCESSES
(SDD 382 boundary) — `CockpitDeps.collect()` cannot call `listClassified()` in-process, which is
also exactly why `disk.ts`'s raw reader existed (a POC-era workaround, commit `656f6393`: zero
tests, lenient parallel parser, `catch {} → []`). The classified read therefore crosses the boundary
as a new engine RPC query `worktrees.classified` (registered in `extensionOperations.ts`'s
`EXTENSION_QUERY_ACTIONS` + `extensionQuerySchema`, handled in `extensionOperationService.ts`
mirroring the existing `worktrees.list`), and the destructive actions cross as two new RPC commands
`worktree.forget-record` and `worktree.remove-managed` (the existing `worktree.remove` /
`worktree.delete-branch` commands are AGENT-name-scoped for Fleet's kill flow, not generic
registry-id operations). This unifies the architecture: after this change every consumer of the
registry — VS Code reveal (`worktrees.list`), Control's Worktrees tab (`worktrees.classified`),
Bridge agents (`list_worktrees`/`worktree_audit`) — flows through the ONE validated
`ManagedWorktreeService` path (fail-closed loader + reconcile); no parallel parsers remain.

Fallback hardened (maintainer-ratified 2026-07-24, "dado não-confiável não é melhor que dado
nenhum"): when the engine RPC is unavailable the Worktrees tab shows an honest error state
("engine unavailable — registry not shown"), NOT unverified raw rows; `readManagedWorktreesFromDisk`
loses its last consumer and is DELETED outright (its sibling `readGitDeliveriesFromDisk` carries the
same debt for the Deliveries tab — out of scope here, tracked as t-43c6fa).

Add a `worktree_audit` read-only Bridge tool (naming precedent: `git_delivery_hygiene`) exposing
the same classifier for Bridge-side/CLI consumers. Add three new `CockpitAction` webview messages —
`worktreeRemove`, `worktreeForgetRecord`, `worktreeBatchCleanup` — handled host-side by invoking the
new RPC commands (which call the existing `ManagedWorktreeService.remove`/`.unregister`; no new
destructive primitives). Batch cleanup needs no atomic server op: each batch item is an individual
forget/remove whose service call re-validates fail-closed on its own, so "an entry drops out of the
batch when its state changed" emerges from per-item refusal, not new logic.

Register `PI-002` (maintainer-approved 2026-07-24) with an evidence test asserting the classifier
never returns `ready-to-remove` for an entry with commits not contained in its base.

## Key decisions

- **New `src/worktree/classify.ts`, not a refactor of `src/git-delivery/classify.ts`'s
  `containedInBase`** — chosen because that function's signature is coupled to the `GitDelivery` type
  (`containedInBase(delivery: GitDelivery, ...)`), and generalizing it to accept a
  `ManagedWorktreeEntry` too means changing spec-365 shipped code for a spec-444 concern (spec.md's
  Non-goals explicitly excludes touching spec 365's internals). The actual git operation
  (`merge-base --is-ancestor` + `git cherry` patch-equivalence fallback) is ~15 lines and cheap to
  reimplement against primitive `(cwd, baseRef, branch)` strings instead of a `GitDelivery` row;
  rejected the shared-extraction refactor (pull the core check into `src/git/ancestry.ts`, have both
  modules import it) as unnecessary blast radius for a one-time, small, stable git primitive — revisit
  only if a third consumer needs the same check.
- **Compute classification on every read, no persisted cache** — chosen because `CockpitDeps.collect()`
  is already `async` and event-driven (verified: no `setInterval` poll drives `sendModel()`, every
  call site is a ready-handshake, user action, or explicit refresh — `src/webview/Cockpit.ts`), so N
  worktrees × a few git subprocess calls per refresh is bounded to real interactions, not a background
  timer; a live-computed verdict can never be stale, which is what "fail-closed" requires. Rejected
  caching classification on the `ManagedWorktreeEntry` registry row: adds invalidation complexity
  (when does a cached `ready-to-remove` verdict get invalidated — on every git operation anywhere?) for
  a performance problem that doesn't exist at today's worktree counts (tens, not thousands).
- **No `ManagedWorktreeEntry` schema change** — chosen because every acceptance criterion is satisfiable
  with classification as a computed overlay returned alongside `list()`/the new Bridge tool; the
  registry stays the durable source of truth for identity (id/kind/path/branch/baseRef/ownership) and
  classification stays ephemeral, computed fresh, never persisted. Rejected adding
  `lastClassifiedAt`/cached-verdict fields: no acceptance criterion needs an audit trail of past
  classifications, and persisting a verdict re-opens the staleness question the compute-on-read
  decision above deliberately avoids.
- **New `worktree_audit` Bridge tool, not a breaking change to `list_worktrees`** — chosen because
  `list_worktrees`'s existing consumers (per t-016e8b/t-05a0b0-era grounding — spawn-path checks,
  registration flows) expect its current lean shape; adding classification fields there is additive
  and low-risk in principle, but a dedicated tool matches the established `git_delivery_list` vs
  `git_delivery_hygiene` split (spec 365) and keeps the classifier's (more expensive: git subprocess
  calls) read path opt-in rather than default for every `list_worktrees` caller. Rejected extending
  `list_worktrees` in place: couples a cheap registry read to an expensive classification computation
  for every existing caller, including ones (agent spawn-path admission checks) that only need the
  identity fields and run on a hot path.
- **`Remove checkout` and `Forget record` reuse `ManagedWorktreeService.remove`/`.unregister`
  unchanged** — chosen because both already implement exactly the required semantics per spec.md
  (occupancy fail-closed, `confirmDirty` gating, `deleteBranch` only when `tachyonCreatedBranch`, no
  remote-branch code path exists anywhere to accidentally trigger). The only real gap is the
  classifier (to decide WHEN to offer these actions) and the webview wiring (to CALL them) — not new
  write-path primitives. Rejected building a new unified "cleanup" write path: would duplicate
  occupancy/dirty gating that `WorktreeManager.remove` already enforces correctly.
- **Batch cleanup re-classifies at confirm time, per-entry, not a single atomic transaction** — chosen
  because spec.md's concurrency acceptance criterion requires a state change between preview and
  confirm to drop that one entry, not fail the whole batch or force it through; per-entry re-check
  before each individual remove/forget call gives that naturally (each call already goes through the
  same fail-closed `ManagedWorktreeService` gating on its own). Rejected a single upfront
  re-classify-all-then-commit-all: a race after that single check but before the last entry's removal
  would reintroduce exactly the gap the concurrency criterion exists to close.

## Files touched

- `src/worktree/classify.ts` (new) — `classifyManagedWorktree()`, the five-state classification, the
  ported minimal ancestry check.
- `src/worktree/ManagedWorktreeService.ts` — no schema change; may gain a thin `listClassified()`
  convenience wrapper the Bridge tool and Cockpit collector both call, to avoid duplicating the
  "list + classify each" loop.
- `src/bridge/tools.ts` — new `worktree_audit` read-only tool registration.
- `src/extension.ts` — `CockpitDeps.collect()`'s worktree line switches from
  `readManagedWorktreesFromDisk` to the classified path; new `CockpitAction` handlers for
  `worktreeRemove`/`worktreeForgetRecord`/`worktreeBatchCleanup`.
- `src/cockpit/disk.ts` — `readManagedWorktreesFromDisk` stays as the fail-closed fallback (classifier
  threw) and/or is inlined into the new collector path; not deleted (spec 392/398 may still reference
  the raw shape).
- `src/webview/cockpit/messages.ts` — new `CockpitAction` message types + the classified row shape on
  the model.
- `src/webview/cockpit/App.tsx` — Worktrees tab: group-by-classification rendering, reason strings,
  gated actions, batch preview/confirm UI.
- `test/product-invariants/registry.json` + new
  `test/product-invariants/PI-002-worktree-cleanup-commit-safety.test.ts`.
- New unit test file(s) for `classify.ts` (tombstone/clean/dirty/unique-commits/non-owned-branch/
  occupied/concurrency) — likely `test/unit/worktreeClassify.test.ts`.

## Risks & unknowns

- **Ancestry-check reimplementation correctness.** The ported minimal containment check must handle
  the same edge cases spec 365's version does (cherry-picked-without-metadata, missing ref) or a
  `ready-to-remove` verdict could be wrong in a way that loses commits — this is exactly what PI-002
  exists to catch, so the PI's evidence test is the concrete proof this risk is closed, not just an
  assertion.
- ~~**Occupancy check scope.**~~ **Resolved:** `AgentManager.worktreeOccupant(worktreePath: string)`
  is already keyed by path, not agent name/kind (`AgentManager.ts:1590`) — it applies unchanged to
  both `kind=agent` and `kind=change` entries. No gap here.
- **`worktree_audit` tool cost on large registries.** Not expected to matter at today's scale, but if
  a workspace accumulates hundreds of abandoned rows, a full re-classify-everything call could be slow;
  no pagination/limit is planned for v1 — flag as a follow-up if it becomes real.

## Visual impact

Control's Worktrees tab changes from a flat list of cards (uniform Reveal/Copy actions) to
classification-grouped sections with per-entry reason text and gated actions (batch selection UI is
new surface). Visual QA required before landing (subjective UI — grouping/reason-text density,
button placement) per the standing maintainer directive; screenshot vs the current Worktrees tab as
the anchor, sign-off before land.

## Sources consulted

- `docs/specs/392-managed-worktree-registry/spec.md`, `plan.md` — registry schema, shipped scope,
  `abandonMissingEntries` semantics.
- `docs/specs/398-worktree-disk-sustainability/plan.md` — unshipped GC classification vocabulary
  (occupied/dirty/delivery-held/grace/pinned/reclaimable), reconciled against but not implemented here.
- `docs/specs/365-orchestrator-delivery-hygiene/spec.md`, `src/git-delivery/classify.ts`,
  `src/git-delivery/prune.ts` — the existing fail-closed classifier/prune precedent this plan mirrors
  and partially ports from.
- `src/worktree/ManagedWorktreeService.ts`, `src/worktree/WorktreeManager.ts` (`status()`, `remove()`,
  occupancy wiring), `src/worktree/managedWorktree.ts` (schema) — current registry/remove machinery.
- `src/cockpit/disk.ts`, `src/webview/cockpit/App.tsx`, `src/extension.ts` (`CockpitDeps.collect`,
  `worktrees.list` engine op at `extensionOperationService.ts`) — current data flow, confirmed
  `collect()` is already async and event-driven (no poll), grounding the compute-on-read decision.
- `src/bridge/tools.ts` (`create_worktree`/`list_worktrees`/`register_worktree`/`unregister_worktree`/
  `remove_worktree` descriptions) — existing write-path safety semantics reused unchanged.
- `test/product-invariants/registry.json`, `docs/architecture/product-invariant-testing.md` — PI
  registration format and governance.
- Live `.tachyon/managed-worktrees.json` (this workspace) — 12 tombstones + 1 dirty active entry used
  as the concrete acceptance-criteria examples in spec.md.

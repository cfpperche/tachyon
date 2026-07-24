# 444 — worktree-registry-hygiene

_Created 2026-07-24._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Control's Worktrees tab (`src/webview/cockpit/App.tsx`) reads `.tachyon/managed-worktrees.json`
raw and unfiltered (`src/cockpit/disk.ts`'s `readManagedWorktreesFromDisk`) and renders every row —
active or `abandoned` — as a card with Reveal/Copy-path actions gated only on the `path` field being
a non-empty string. `abandonMissingEntries` (spec 392) flips `active → abandoned` when a path stops
existing, but never clears the `path` field itself, so an abandoned tombstone still shows Reveal/Copy
as if the checkout were real. Live in this workspace today: 12 of 13 registry rows are pure
tombstones (directory physically gone) and the one real active checkout is currently dirty (5
modified + 3 untracked files, 0 commits ahead of its recorded base) — exactly the case the current
binary `active | abandoned` schema cannot express: it is neither a clean ready-to-clean checkout nor
a gone-forever tombstone, but the UI has no third state to put it in.

Separately, the engine's `worktrees.list` operation (`extensionOperationService.ts`, used only for
VS Code multi-root reveal) *does* re-check `fs.existsSync` at query time and filters gone paths —
so two call paths already disagree about what "exists" means, and neither computes anything richer
(dirty, ahead-of-base, occupied, branch ownership). That richer classification machinery already
exists, but only for a parallel/narrower data model: `src/git-delivery/classify.ts` (spec 365)
computes exactly this (`clean`, `containedInBase`, `liveState`, a `hygieneReport()` taxonomy) for
`GitDelivery` records, which cover only ad-hoc `worktree:true` agent spawns — not every
`ManagedWorktreeEntry` (misses `kind=change`, misses non-autoOpen agents). No function today composes
the scattered fail-closed primitives (`WorktreeManager.status()` for dirty/ahead,
`AgentManager.worktreeOccupant()` for occupancy, `tachyonCreatedBranch` for ownership,
`git-delivery/classify.ts`'s `containedInBase` for ancestry) into a classification for a
`ManagedWorktreeEntry`.

"Done" is: Control's Worktrees tab becomes a safe hygiene surface built on one authoritative,
fail-closed classification (engine-computed, not webview-inferred) that distinguishes a real active
checkout from a registry-only tombstone from a genuinely-safe-to-remove checkout, never auto-deletes
anything, always explains why an entry is blocked from cleanup, and never renders a Reveal/Copy
action against a path that does not exist.

## Acceptance criteria

- [ ] **Scenario: a registry-only tombstone never offers Reveal as if the path existed**
  - **Given** a `ManagedWorktreeEntry` whose `path` does not exist on disk (the current 12 live
    tombstones: `spec376-dogfood-impl`, `salvagecleanup1`, `visualqa-072`, `impl-240a3b`,
    `companion-tab-tools-v2-foundation`, `companion-tab-tools-v2-p0`, `agent-evolution`,
    `pin-studio-header-cancel-dirty`, `pin-studio-editor-not-typable`,
    `task-studio-new-cancel-back-route`, `control-fullpage-subroute-prototype`,
    `pin-task-studio-save-navigate`)
  - **When** Control's Worktrees tab renders it
  - **Then** it is classified `record-only` (or equivalent), Reveal/Copy-path are not offered, and
    the row instead offers a `Forget record` action

- [ ] **Scenario: a clean, unoccupied, base-contained checkout is ready to remove**
  - **Given** a real git worktree whose path exists, git status is clean, it is not occupied by a
    live agent, it has zero commits not already contained in its recorded base, and it carries no
    unique work
  - **When** the classifier runs
  - **Then** the entry is `ready-to-remove` and the UI offers a `Remove checkout` action that, when
    confirmed, calls `ManagedWorktreeService.remove`/the `remove_worktree` Bridge path (occupancy
    fail-closed, as today) and leaves git + the registry consistent afterward

- [ ] **Scenario: a dirty, ahead, unknown-ancestry, non-owned-branch, or occupied checkout blocks
    destructive cleanup with a stated reason**
  - **Given** a real checkout matching any one of: uncommitted changes, commits not contained in its
    base, an occupying live agent, or (for branch deletion specifically) a branch Tachyon did not
    create (`tachyonCreatedBranch: false`)
  - **When** the classifier runs
  - **Then** the entry is `needs-review` (or `occupied` when that is specifically the blocking
    reason), the destructive `Remove checkout` action is not offered (or is disabled), and the UI
    states which specific condition is blocking it — this workspace's real `session-continuation-*`
    entry (dirty, 0 ahead) is the running example: it must land as `needs-review: dirty`, never
    `ready-to-remove` and never silently treated as a tombstone

- [ ] **Scenario: local branch deletion is opt-in and ownership-gated**
  - **Given** a `ready-to-remove` (or user-confirmed `needs-review`) checkout with a local branch
  - **When** the human removes the checkout
  - **Then** the local branch is deleted only with explicit consent in the same action and only when
    `tachyonCreatedBranch` is true; a non-Tachyon-owned branch is never offered for deletion; no
    remote branch or ref is ever touched by any action this spec introduces

- [ ] **Scenario: batch cleanup only ever acts on entries the classifier already marked safe**
  - **Given** a multi-select batch cleanup action (if built) with a preview step
  - **When** the human confirms
  - **Then** only entries already classified `record-only` (forget) or `ready-to-remove` (remove)
    at preview time are eligible for selection; the preview and the confirm step re-derive
    classification from the same authoritative source so a state change between preview and confirm
    (e.g., an agent starts occupying a path mid-preview) causes that one entry to drop out of the
    batch rather than being force-removed

- [ ] Classification is computed by the engine (`ManagedWorktreeService` or a sibling module), never
      inferred by the webview from raw JSON; Control's Worktrees tab consumes the classified result,
      not `disk.ts`'s current unfiltered `readManagedWorktreesFromDisk` pass-through (that reader is
      either replaced or demoted to a fallback that is never trusted for action-gating).
- [ ] A path becoming inaccessible mid-remove is a stated failure/needs-review outcome, never
      silently reported as a successful removal (no ambiguous success on a missing path).
- [ ] Tests cover: tombstone (missing path), clean ready-to-remove, dirty, unique/unmerged commits
      ahead of base, non-Tachyon-owned branch, occupied, and a concurrency case where the entry's
      real state changes between a batch preview computation and its confirm step.
- [ ] `PI-002` ("a destructive worktree/branch cleanup action never discards unique, unmerged commits
      without an explicit, informed override") is registered in
      `test/product-invariants/registry.json` with a passing evidence test, per the maintainer's
      2026-07-24 decision to formalize this safety promise (see Open questions).

## Non-goals

- Automated/scheduled disk reclamation on a timer or budget (VHDX/npm-cache bytes, retention grace
  windows, `settings.worktree.gc.*` config) — that is spec 398's unshipped scope (disk
  sustainability). This spec may reuse spec 398's classification *vocabulary* where it fits, but does
  not implement its GC service or disk-bytes accounting.
- Reworking GitDelivery's own hygiene system (`git_delivery_hygiene`/`git_delivery_prune`, spec 365)
  — that stays the authority for `GitDelivery`-tracked ad-hoc worktree spawns. This spec's
  classifier may port or call the same low-level primitives (`containedInBase`, dirty/status probes)
  but does not change spec 365's tools, store, or Phase 2 (review/integrate) scope.
- Deleting or force-pushing any remote branch or ref, under any action this spec introduces — not
  even with explicit human consent. Remote branch lifecycle stays entirely out of scope.
- Any *automatic* deletion path (no action removes a checkout, forgets a record, or deletes a branch
  without an explicit, per-entry (or per-batch-preview) human confirmation).
- Reworking `WEBVIEW_SURFACES`/Control shell mechanics (SDD 410) — the Worktrees tab is already a
  native Control section; this spec changes its data source and actions, not its hosting.

## Open questions

- **Reuse vs. port vs. rebuild the classifier primitives.** `git-delivery/classify.ts` already has
  `containedInBase` (merge-base ancestor + cherry-pick equivalence) and a `hygieneReport()` category
  taxonomy for `GitDelivery` rows. Does 444's classifier import/generalize those functions to also
  accept a `ManagedWorktreeEntry`, or duplicate the git plumbing in a new `src/worktree/classify.ts`
  (mirroring the existing `src/git-delivery/classify.ts` file shape)? Owner: plan.md, before any
  code — the research shows both the primitives and their call shape, so this is a naming/placement
  decision, not new design.
- **Compute-on-read vs. cache in the registry.** Fail-closed favors always recomputing dirty/ahead/
  occupancy live on every Cockpit refresh (no staleness risk), but that means N worktrees → N sets of
  git subprocess calls per refresh. Given typical counts (tens, not thousands) this is likely fine,
  but plan.md should state the choice and, if caching is chosen instead, how invalidation stays
  fail-closed (never serve a stale `ready-to-remove` verdict).
- **Does `ManagedWorktreeEntry`'s schema change**, or does classification stay purely an ephemeral,
  computed-not-persisted overlay returned alongside `list()`/a new read tool? The task's acceptance
  criteria don't require a schema change; leaning toward computed-only unless plan.md finds a
  concrete reason to persist (e.g. a `lastClassifiedAt` audit trail).
- **New Bridge tool(s) vs. richer existing ones.** `unregister_worktree` already does exactly
  "Forget record" (drops the row without touching disk) and `remove_worktree` already does the
  occupancy-fail-closed remove with `confirmDirty`/`deleteBranch` gating — the likely gap is only a
  new *read* path that returns classification (richer `list_worktrees`, or a new
  `list_worktrees_classified`-shaped tool) plus new `CockpitAction` webview messages wiring the UI to
  the existing write tools. Confirm in plan.md whether any write-path gap remains beyond wiring.
- ~~**Product Invariant.**~~ **Resolved (maintainer, 2026-07-24): register it.** `PI-002` —
  "a destructive worktree/branch cleanup action never discards unique, unmerged commits without an
  explicit, informed override" — gets a registry entry (`test/product-invariants/registry.json`) and
  an evidence test (`test/product-invariants/PI-002-worktree-cleanup-commit-safety.test.ts`) sourced
  from this spec, fixed oracle = git ancestry (`containedInBase`/`commitsNotInBase`). Tracked as an
  acceptance criterion below.

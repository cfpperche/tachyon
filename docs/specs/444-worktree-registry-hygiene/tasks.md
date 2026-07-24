# 444 — worktree-registry-hygiene — tasks

_Generated from `plan.md` on 2026-07-24. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] `src/worktree/classify.ts`: define `WorktreeClassification` (four algorithmic states — `active`
      stays the separate, unchanged registry `status` field, see notes.md — + a `reasons: string[]`
      field) and `classifyManagedWorktree(entry, deps)`. Path existence (`record-only` if missing)
      alone already fixes the tombstone Reveal/Copy bug.
- [x] `classify.ts`: dirty/ahead-of-base via the injected `status(cwd, baseRef)` probe (same shape as
      `WorktreeManager.status()`).
- [x] `classify.ts`: occupancy via the injected `occupancy(worktreePath)` probe (same shape as
      `AgentManager.worktreeOccupant`); a live occupant always overrides dirty/needs-review.
- [x] `classify.ts`: ported minimal containment check (`aheadOfBase === 0` as the primary signal +
      `git cherry` patch-equivalence fallback when ahead, mirroring `git-delivery/classify.ts`'s
      `patchesAllInBase` — no import from `git-delivery/`).
- [x] `classify.ts`: compose the above into the four-state verdict + human-readable `reasons`;
      probe failures fail closed to `needs-review`, never `ready-to-remove`. 8/8 unit tests green
      (`test/unit/worktreeClassify.test.ts`): tombstone, clean, dirty, unique-commits,
      cherry-equivalent-still-safe, occupied-wins-over-dirty, failed-status-probe, failed-occupancy-probe.
- [x] `ManagedWorktreeService.ts`: add `listClassified()` wrapping `list()` + `classifyManagedWorktree`
      per entry (parallelized; one entry's classification failure doesn't fail the batch — caught
      per-entry, rendered `needs-review: classification failed`). 5 real-git integration tests added
      to `managedWorktree.test.ts` (clean, dirty, ahead, occupied, tombstone) — 21/21 in the file.
- [x] `src/bridge/tools.ts`: register `worktree_hygiene` (read-only, reuses `list_worktrees`'s
      auth/filter shape, returns classified rows via `listClassified()`). Catalog test updated
      (71→72 canonical tools); real behavioral coverage lives in `managedWorktree.test.ts`'s
      `listClassified()` suite, same precedent as `list_worktrees`/`create_worktree`'s own coverage
      split. 68/68 in `bridge.test.ts`.
- [ ] `src/extension.ts`: `CockpitDeps.collect()`'s worktree line switches to `listClassified()`;
      `readManagedWorktreesFromDisk` becomes the fail-closed fallback only (classifier threw).
- [ ] `src/webview/cockpit/messages.ts`: add `worktreeRemove`, `worktreeForgetRecord`,
      `worktreeBatchCleanup` `CockpitAction` variants + the classified row shape on the model.
- [ ] `src/extension.ts`: host handlers for the three new actions, calling
      `ManagedWorktreeService.remove`/`.unregister` unchanged; batch handler re-classifies each
      selected id at confirm time and drops (with reason) any that no longer qualify.
- [ ] `src/webview/cockpit/App.tsx`: Worktrees tab — group by classification, show `reasons`, gate
      actions per state, add batch selection + preview/confirm UI for the `record-only`/
      `ready-to-remove` groups.
- [x] `test/product-invariants/registry.json` + `PI-002-worktree-cleanup-commit-safety.test.ts`:
      registered per the maintainer's 2026-07-24 decision (spec.md Open questions). Two independent
      oracles in one real-git test: the classifier never returns `ready-to-remove` for a commit not
      contained in base, AND `git branch -d` independently refuses ("not fully merged") once the
      worktree is removed — proven against a real repo, not fakes. `npm run test:invariants`:
      "Product Invariant gate passed: 2 invariant(s), 3 test(s)." Governance doc catalog updated.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] Tombstone entries (path missing) classify `record-only`, no Reveal/Copy offered, `Forget
      record` available — verified against this workspace's live 12 tombstones as a fixture/example.
- [ ] Clean/unoccupied/contained/zero-unique-commits checkout classifies `ready-to-remove`.
- [ ] Dirty, ahead-with-unique-commits, unknown-ancestry, and occupied checkouts classify
      `needs-review`/`occupied` with a stated reason and no destructive action offered — including
      this workspace's real `session-continuation-*` entry (dirty, 0 ahead) as a concrete case.
- [ ] Non-`tachyonCreatedBranch` never offers branch deletion; no remote-branch code path exists
      anywhere in the diff (grep confirms zero `push --delete`/remote-delete additions).
- [ ] Batch preview → confirm concurrency: an entry whose classification changes between preview and
      confirm drops out of the batch with a stated reason, rest proceed.
- [ ] `PI-002` registered and its evidence test passes.

**Headless check:** `npm run typecheck && npx vitest run test/unit/worktreeClassify.test.ts test/product-invariants/PI-002-worktree-cleanup-commit-safety.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

**Verify:** `npm run typecheck`
**Verify:** `npx vitest run test/unit/worktreeClassify.test.ts test/product-invariants/PI-002-worktree-cleanup-commit-safety.test.ts`

## Dogfood

**Dogfood:** `npx vitest run test/unit/worktreeClassify.test.ts`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** open Control → Worktrees in this workspace; confirm the 12 live tombstones show
as `record-only` with a `Forget record` action (no Reveal/Copy), and the one active `session-
continuation-*` entry shows `needs-review: dirty` — this workspace's real registry state is the
built-in acceptance fixture.

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [ ] Evidence:
- [ ] Verdict:

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <444>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook:** yes
<!-- ships a new Bridge tool (worktree_hygiene) plus new destructive actions (Remove checkout,
     Forget record, batch cleanup) — a short operator how-to belongs here before this ships. -->

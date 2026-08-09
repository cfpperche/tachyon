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
- [x] `src/bridge/tools.ts`: register `worktree_audit` (read-only, reuses `list_worktrees`'s
      auth/filter shape, returns classified rows via `listClassified()`). Catalog test updated
      (71→72 canonical tools); real behavioral coverage lives in `managedWorktree.test.ts`'s
      `listClassified()` suite, same precedent as `list_worktrees`/`create_worktree`'s own coverage
      split. 68/68 in `bridge.test.ts`.
- [x] `src/extension.ts`: `CockpitDeps.collect()` queries the new `worktrees.classified` engine RPC
      (plan revised: process boundary — see notes.md). `readManagedWorktreesFromDisk` DELETED
      outright (maintainer-hardened fallback: engine unreachable → honest error state, never
      unverified rows).
- [x] `src/webview/cockpit/messages.ts`: `worktreeRemove` / `worktreeForgetRecord` /
      `worktreeBatchCleanup` `CockpitAction` variants + hygiene strings; classified row shape on
      `CockpitWorktreeRow` (+ `worktreesUnavailable` on bundle/model).
- [x] Host handlers (Cockpit.ts cases + extension.ts deps → `worktree.remove-managed` /
      `worktree.forget-record` engine commands, which call `ManagedWorktreeService.remove`/
      `.unregister` unchanged). Batch = per-item engine re-validation; a refused item is skipped
      with its reason, rest proceed. Covered by `cockpitWorktreeActions.test.ts` (5 tests).
- [x] `src/webview/cockpit/App.tsx`: `WorktreesHygiene` — 4 groups (approved mockup), inline
      reasons, gated/disabled-with-reason actions, per-click branch-deletion consent
      (tachyonCreatedBranch only), batch selection restricted to the 2 safe groups with review
      dialog, record-only collapse past 4, engine-unavailable error state. `ck-wt-*` CSS via
      design-system tokens only.
- [x] `test/product-invariants/registry.json` + `PI-002-worktree-cleanup-commit-safety.test.ts`:
      registered per the maintainer's 2026-07-24 decision (spec.md Open questions). Two independent
      oracles in one real-git test: the classifier never returns `ready-to-remove` for a commit not
      contained in base, AND `git branch -d` independently refuses ("not fully merged") once the
      worktree is removed — proven against a real repo, not fakes. `npm run test:invariants`:
      "Product Invariant gate passed: 2 invariant(s), 3 test(s)." Governance doc catalog updated.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Tombstone entries (path missing) classify `record-only`, no Reveal/Copy offered, `Forget
      record` available — unit (worktreeClassify) + real-git integration (managedWorktree) + a11y
      tree of the rendered tab (preview harness) all confirm.
- [x] Clean/unoccupied/contained/zero-unique-commits checkout classifies `ready-to-remove`
      (unit + real-git integration).
- [x] Dirty, ahead-with-unique-commits, unknown-ancestry (probe failure), and occupied checkouts
      classify `needs-review`/`occupied` with a stated reason; the rendered tab disables Remove with
      the reason as tooltip (a11y tree shows the disabled buttons).
- [x] Non-`tachyonCreatedBranch` never offers branch deletion (UI renders consent only for owned
      branches; service enforces regardless); grep of the diff confirms zero remote-branch
      operations added.
- [x] Batch preview → confirm concurrency: covered host-side in `cockpitWorktreeActions.test.ts`
      (refused item skipped with reason, rest proceed) — the engine re-validation itself is the
      dirty-refusal path proven in `managedWorktree.test.ts`.
- [x] `PI-002` registered and its evidence test passes (`test:invariants`: 2 invariants, 3 tests).

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

- [x] Evidence: maintainer-approved interactive mockup (scratchpad `444-worktrees-mockup.html` +
      dark screenshot, approved 2026-07-24 pre-implementation); rendered-UI a11y tree via
      agent-browser (all 4 groups, gated buttons, checkboxes correct); preview-harness screenshots
      (`444-real-ui2.png`) — LIMITATION: the webview-preview harness has a pre-existing layout
      defect that breaks ALL native cockpit sections identically (proved via untouched Deliveries
      comparison `444-deliveries-compare.png`; filed as t-e085bc), so pixel-accurate pre-land proof
      was not obtainable from the harness.
- [x] Verdict: structure/copy/gating verified (mockup + a11y); pixel-level pass deferred to the
      maintainer's human dogfood in the real Control (route below), with t-e085bc unblocking
      harness-based passes for future sections.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <444>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook:** yes
<!-- ships a new Bridge tool (worktree_audit) plus new destructive actions (Remove checkout,
     Forget record, batch cleanup) — a short operator how-to belongs here before this ships. -->

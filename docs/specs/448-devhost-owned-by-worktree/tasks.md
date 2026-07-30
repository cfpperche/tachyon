# 448 — devhost-owned-by-worktree — tasks

_Generated from `plan.md` on 2026-07-24. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

**T1 gates everything below it. Nothing is deleted until T1 passes.**

- [x] **T1 — prove the load-bearing assumption (plan R1).** From a linked worktree, arm a dev-host by
      hand at `<worktree>/.tachyon/dev-host/` (mirror the current `pathsOf` layout, flat), point a
      `launch.json` entry at `${workspaceFolder}/.tachyon/dev-host/…`, open VS Code **on that
      worktree**, and press F5. Record in `notes.md`: did the EDH launch, and did WSL stay connected
      (no `Disconnected from WSL` / `Extension 'WSL' is required`)? **If it fails, stop and re-open
      `spec.md` — do not work around it.**
- [x] **T2 — flatten the layout.** `pathsOf(checkoutRoot)` returns `dev-host/{extension,workspace,runtime,meta.json,user-data,extensions,tmux,cache,profile-home}` with no `slots/` segment and no slot id parameter.
- [x] **T3 — root the dev-host in the current checkout.** `point()` builds under the checkout it runs
      in. Rename the redirect to `resolvePrimaryRepoRoot` and narrow its use to `ensureNodeModules` /
      `ensureWorktreeToolBin` only (plan D1) — it must no longer choose the dev-host root.
- [x] **T4 — retire the flags loudly.** `--owner` and `--slot` raise an error naming the replacement
      flow (no window, plan D4). `--worktree` becomes optional, defaulting to the current checkout.
- [x] **T5 — delete the slot/active machinery.** `SLOTS_SUBDIR`, `ACTIVE_LINK`, `normalizeSlotId`,
      `resolveSlotId`, `slotsDir`, `activeLinkPath`, `setActiveSlot`, `readActiveSlotId`,
      `reconcileActiveSlot`, `listSlotIds`, `migrateFlatPointerToSlots`, `isFlatPointerLayout`,
      `statusAll`, and the per-slot launch naming in `point()`.
- [x] **T6 — make `launch.json` static (plan D3).** Delete `ensurePortableLaunchConfig`,
      `writeAbsoluteLaunchConfig`, `restoreTemplateLaunchConfig` and every call site. Commit a single
      `Tachyon: Dev Host` entry resolving through `${workspaceFolder}/.tachyon/dev-host/…`.
- [x] **T7 — retarget the headless harnesses (plan D5).** `resolvePointerSlotRoot` in
      `headless-session.mjs` and `headless-interactive.mjs` collapses to this checkout's dev-host.
      Partially reverts `4c58cee8`; behavior otherwise unchanged.
- [x] **T8 — drop `--owner`/`--slot` pass-through** in `scripts/dev-host/lane.mjs` and `cli.sh`.
- [x] **T9 — rewrite the tests (plan R4, the bulk of the work).** Delete the `t-efe06d: multi-slot
      isolation` block; **invert** `resolveF5HostRepoRoot redirects linked worktree to primary` and
      `point from linked-worktree … still arms monorepo` to assert the new ownership; retarget the
      `t-e357dc` stale-engine block off `slotRoot`; keep `links node_modules from primary` (it pins
      D1). Audit `devHostBoundary`, `devHostLane`, `devHostLauncher` for slot assumptions. For each
      deleted test, confirm it tested slots and not some unrelated behavior riding along.
- [x] **T10 — structural guard.** New test banning `.tachyon/dev-host/active` and any `slots/` layout
      across `scripts/`, `src/`, `test/`, `docs/`. Prove it non-vacuous: reintroduce a reference,
      watch it fail, remove it.
- [x] **T11 — runbook.** `docs/runbooks/dev-host.md`: one flow (arm in your worktree → open VS Code
      there → F5). Remove the 32 slot/owner/active lines. State plainly that a worktree now grows by
      the size of its dev-host (plan R2) — do not claim a disk saving.
- [x] **T12 — migration residue.** Restore the primary checkout's `.vscode/launch.json` to its
      committed state (the two slot entries come out), and document how to reclaim the pre-existing
      `slots/` directories (588M measured 2026-07-24).

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Two worktrees each arm a dev-host and run an EDH concurrently, neither touching the other, with no slot identifier anywhere → spec scenario 1.
- [x] `git status --porcelain` is byte-identical before and after an arm, in every checkout → spec scenario 2.
- [x] Removing a worktree removes its dev-host with it; no directory is left in the primary monorepo → spec scenario 3.
- [x] The headless harness invoked inside a worktree resolves that worktree's dev-host, with no `active` indirection → spec scenario 4.
- [x] `--owner` / `--slot` exit non-zero with a message naming the replacement → spec scenario 5.
- [x] `.vscode/launch.json` is written by no script and is identical across checkouts → spec static fact 1.
- [x] The structural guard fails when `active`/`slots/` is reintroduced → spec static fact 2.

**Headless check:** `npx vitest run test/unit/devHostPointer.test.ts test/unit/devHostBoundary.test.ts test/unit/devHostLane.test.ts test/unit/devHostLauncher.test.ts`

**Verify:** `npm run typecheck`
**Verify:** `npx vitest run test/unit/devHostPointer.test.ts test/unit/devHostBoundary.test.ts test/unit/devHostLane.test.ts test/unit/devHostLauncher.test.ts`

## Dogfood

**Dogfood:** `npm run dogfood -- dev-host -- point --fixture agent-soul-dogfood && npm run dogfood -- dev-host -- point-status && npm run dogfood -- dev-host -- point-clear`

<!-- The first declaration here was just `point-status`, which was wrong: on an unarmed checkout that
     exits 1 by design ("unarmed" is not success), so it only passed by accident when something
     happened to be armed. The loop above is self-contained and actually exercises what shipped —
     arm this checkout, confirm it reports armed, then reclaim it — and leaves no dev-host behind. -->


**Human dogfood:** T1 is itself the human dogfood and it runs FIRST, not last: open VS Code on a linked
worktree, press F5, confirm the EDH launches and WSL stays connected. A second pass after T12 confirms
the same flow still works on the shipped code, and that a concurrent second worktree does not disturb it.

## Visual QA

**Visual QA Opt-Out:** developer tooling only; no product surface changes. The single human-visible
artifact is the Run and Debug dropdown, verified by the T1/T12 dogfood rather than by screenshot.

## Cookbook

**Cookbook-Opt-Out:** no new operator surface — this removes flags (`--owner`, `--slot`) and an
indirection (`active`) from an existing CLI whose remaining flow is documented in
`docs/runbooks/dev-host.md`, which T11 rewrites.

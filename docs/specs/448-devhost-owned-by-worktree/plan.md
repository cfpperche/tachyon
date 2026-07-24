# 448 — devhost-owned-by-worktree — plan

_Drafted from `spec.md` on 2026-07-24. The approach, not the steps (those go in `tasks.md`)._

## Approach

`point()` currently takes a `repoRoot` — the **primary monorepo**, found by redirecting *away* from the
worktree — plus a separate `worktree` that is only ever a symlink target. The dev-host is built under
`repoRoot`. **Invert that: the dev-host is built under the checkout you are standing in.**

Every other mechanism exists to manage the sharing that this creates: slots partition the shared
directory, `active` selects which slot F5 uses, `.vscode/launch.json` is rewritten to index the slots,
and the redirect exists so a worktree can reach back to the shared thing. Once the dev-host is not
shared, all of it has nothing left to manage and comes out.

Sequenced so the one falsifiable assumption is tested before anything is deleted (see Risks R1).

## Key decisions

- **D1 — the redirect is repurposed, not deleted (corrects the task body).** The task said to delete
  `resolveF5HostRepoRoot`. The code says otherwise: `ensureNodeModules(worktree, repoRoot)`
  (`pointer.mjs:421`) symlinks the primary monorepo's `node_modules` into a worktree that lacks one,
  and `ensureWorktreeToolBin` does the same for `.tachyon/bin`. That worktree→primary dependency is
  real and legitimate. So the git-common-dir resolution survives, renamed to say what it now means
  (`resolvePrimaryRepoRoot`), and its use narrows: it locates the primary repo **to borrow
  dependencies from**, and no longer decides where the dev-host lives. Rejected deleting it outright —
  that breaks every worktree without its own `node_modules`.

- **D2 — the new layout is the OLD flat layout, relocated.** `pathsOf(repoRoot, slotId)` returns
  `…/dev-host/slots/<id>/{extension,workspace,runtime,…}`; the new shape is
  `…/dev-host/{extension,workspace,…}` — exactly the pre-multi-slot flat layout, rooted in the worktree
  instead of the monorepo. So `migrateFlatPointerToSlots` is not merely deleted, it is **reversed in
  intent**: the layout it migrated away from is the one we return to. Rejected keeping a one-entry
  `slots/default/` "for future-proofing" — it preserves the vocabulary and the indirection while
  delivering none of their value, and the acceptance criteria ban the layout.

- **D3 — `launch.json` becomes static and nobody writes it.** `ensurePortableLaunchConfig` /
  `writeAbsoluteLaunchConfig` / `restoreTemplateLaunchConfig` exist to keep a *generated* file honest.
  With one identical entry per checkout there is nothing to generate: delete the writers, commit the
  file, replace them with a test asserting the entry's shape. Rejected gitignoring `launch.json` and
  generating it from a committed template — it buys onboarding friction (a fresh clone cannot F5 until
  a bootstrap runs) to solve a problem that disappears once the content stops varying.

- **D4 — `--worktree` becomes implicit; `--owner`/`--slot` fail hard.** The checkout you run in *is*
  the target. Per the maintainer's 2026-07-24 call there is **no deprecation window**: `--owner` and
  `--slot` raise an error naming the replacement flow. Rejected a warn-then-remove release — a silent
  no-op would half-arm a dev-host and point the caller at a directory that is not the one being
  launched, which is worse than a hard stop.

- **D5 — `4c58cee8` is partially reverted, deliberately.** That commit (landed shortly before this
  plan, still unpushed) taught `headless-session.mjs` and `headless-interactive.mjs` to resolve
  `active` → `slots/<id>`. This spec removes what it resolves, so `resolvePointerSlotRoot` collapses to
  "the dev-host of this checkout". Not a rejection of that work — it correctly fixed the harness
  against the layout that existed then. Recorded so the revert reads as intentional and its author
  sees it.

## Files touched

| File | Change |
|---|---|
| `scripts/dev-host/pointer.mjs` | delete the slot/active machinery (`SLOTS_SUBDIR`, `ACTIVE_LINK`, `normalizeSlotId`, `resolveSlotId`, `slotsDir`, `activeLinkPath`, `setActiveSlot`, `readActiveSlotId`, `reconcileActiveSlot`, `listSlotIds`, `migrateFlatPointerToSlots`, `isFlatPointerLayout`, `statusAll`, the launch writers); flatten `pathsOf`; rename + narrow the redirect (D1); fail-hard on retired flags (D4) |
| `scripts/dev-host/headless-session.mjs` | `resolvePointerSlotRoot` → this checkout's dev-host (D5) |
| `scripts/dev-host/headless-interactive.mjs` | same |
| `scripts/dev-host/lane.mjs`, `scripts/dev-host/cli.sh` | drop `--owner`/`--slot` pass-through where present |
| `.vscode/launch.json` | one static entry; remove the slot entries currently dirtying the primary checkout |
| `test/unit/devHostPointer.test.ts` | delete the `t-efe06d: multi-slot isolation` block (6 tests); **invert** `resolveF5HostRepoRoot redirects linked worktree to primary` and `point from linked-worktree … still arms monorepo`; retarget the `t-e357dc` stale-engine block (6 tests) off `slotRoot`; keep `links node_modules from primary` — it pins D1 |
| `test/unit/devHostBoundary.test.ts`, `devHostLane.test.ts`, `devHostLauncher.test.ts` | audit for slot assumptions |
| new structural test | ban `.tachyon/dev-host/active` and any `slots/` layout across scripts/src/test/docs, so the shape cannot return silently |
| `docs/runbooks/dev-host.md` | one flow (arm in your worktree → open VS Code there → F5); state that worktrees grow by their dev-host; drop the 32 slot/owner/active lines |

## Risks & unknowns

1. **R1 — the load-bearing untested assumption.** Opening VS Code on a *linked worktree* and pressing
   F5 must not trigger `Disconnected from WSL` / `Extension 'WSL' is required` (`dev-host.md:48`).
   Everything here is `${workspaceFolder}`-relative so the expectation is that it is fine, but the
   whole design rests on it. **Mitigation: prove it first, before a single deletion lands.** If it
   fails, the spec re-opens rather than getting worked around.
2. **R2 — disk moves rather than shrinks, short-term.** Per-worktree dev-hosts are the same count as
   per-agent slots; a long-lived worktree now carries its ~126M+. The win is lifecycle (removal
   reclaims) not footprint. Name it in the runbook; do not claim a saving.
3. **R3 — callers outside this repo.** Agent prompts may still pass `--owner`. Fail-hard is the
   maintainer's explicit call, so the blast is intended — but the error text is the entire mitigation
   and must name the replacement flow.
4. **R4 — the test rewrite is the bulk of the work,** not the source change: 68 lines of
   `devHostPointer.test.ts` mention slot/active/owner. The real risk is silently dropping a behavior
   that had nothing to do with slots while deleting its enclosing test.

## Visual impact

None. No product surface changes — this is developer tooling. The only human-visible artifact is the
Run and Debug dropdown, which goes from "one stable entry plus one per slot" to a single entry per
checkout. **Visual QA Opt-Out:** no product UI is touched; the F5 dropdown is verified by the R1
dogfood, not by screenshot.

## Sources consulted

- `scripts/dev-host/pointer.mjs` — full export map; `point()` (816–910), `pathsOf` (162), `ensureNodeModules` (421), `resolveF5HostRepoRoot` (89), launch writers (694–815).
- `scripts/dev-host/headless-session.mjs`, `headless-interactive.mjs` — `resolvePointerSlotRoot`, added by `4c58cee8`.
- `test/unit/devHostPointer.test.ts` — 27 tests; 68 lines referencing slot/active/owner.
- `docs/runbooks/dev-host.md` — lines 48 (WSL re-entry warning), 407 (pointer instead of one-off launch.json paths), 436 (stable F5 config).
- `.vscode/launch.json` (committed base + the two slot entries dirtying the primary checkout), `.gitignore:13` (`.tachyon/` ignored in every checkout).
- Live layout: `.tachyon/dev-host/slots/{codex,grok}` — 126M + 462M measured 2026-07-24.
- Related: `t-efe06d` (introduced multi-slot), `t-2a2af8` (VHDX growth), `docs/specs/393-dev-host-dogfood-ergonomics`.

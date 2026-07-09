# 365 — orchestrator-delivery-hygiene — tasks

_Phase 1 only. Generated from plan.md 2026-07-09._

## Implementation

- [ ] Types + phase transition validation (`src/git-delivery/types.ts`)
- [ ] Store: atomic JSON, list, get, create, update with version CAS, uniqueness on
      branchRef/worktreePath for non-pruned (`store.ts`)
- [ ] Git port + `containedInBase` (ancestor and cherry-empty) + hygiene classifier
- [ ] Prune predicates + execute (worktree remove, optional branch -D, forceLoseCommits)
- [ ] Settings parse `settings.gitDelivery` + profile bundles (solo/balanced/strict/custom)
- [ ] Wire Workspace: open store, autoOpen on worktree ad-hoc spawn, liveness/git deps
- [ ] Bridge tools: `git_delivery_list`, `git_delivery_hygiene`, `git_delivery_open`,
      `git_delivery_prune` with actor checks
- [ ] Ensure `.tachyon/git-deliveries/` gitignored
- [ ] Unit tests for store CAS, containment, hygiene categories, prune refuse/success,
      abandon worktree-only, missing_ref, actor refuse peer prune
- [ ] `npm run typecheck` + focused tests green; prefer `npm run verify:full`

## Verification

**Verify:** `npx vitest run test/unit/gitDelivery`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood-Opt-Out:** Phase 1 is store/tools; full wave prune dogfood is human/orchestrator
after VSIX. Headless = unit suite.

**Human dogfood (optional):** spawn worktree agent → list shows open → after cherry-pick to
main → hygiene ready_to_prune → prune cleans branch.

## Visual QA

**Visual QA Opt-Out:** no new UI in Phase 1 (Bridge tools only).

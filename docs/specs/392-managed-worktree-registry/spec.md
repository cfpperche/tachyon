# Spec 392 — Managed worktree registry

**Status:** shipped-partial
**Date:** 2026-07-16
**Task:** t-689e6c
**Closure:** v1 registry + Bridge tools + prune migration + agent sync + worktrees.list merge for reveal; installed multi-root dogfood deferred.

## Problem

Tachyon has a solid **agent** worktree engine (`WorktreeManager`) but no product-level registry for **all** managed checkouts. Agents invent sibling paths, VS Code reveal only sees spawn-bound agent worktrees, and some call sites still shell `git worktree remove` directly (e.g. GitDelivery prune).

## Goals

1. Durable **registry** of managed worktrees (`kind: agent | change`) under a canonical base.
2. **Bridge tools**: create / list / get / register / unregister / remove.
3. **Reveal** in multi-root VS Code from registry + agent live records.
4. **Migrate** direct `git worktree` mutate call sites that are product-owned to go through the engine (WorktreeManager / ManagedWorktreeService).
5. Fail-closed remove (occupancy, dirty optional gates).

## Non-goals

- Auto-merge to main / auto-push PR.
- SSH remote worktrees.
- Second Bridge/tmux per worktree folder (folders stay view-only).
- Replacing Delivery/verify hermetic clones.

## Affected Product Invariants

`none` — orchestration infrastructure for managed checkouts; no registered PI promise change.

## Acceptance criteria

- [ ] **Scenario: create change worktree**
  - **Given** a git workspace with Bridge
  - **When** `create_worktree` kind=change with a slug/taskId
  - **Then** a real git worktree exists under the managed base, is registered, and appears in `list_worktrees`
- [ ] **Scenario: agent ensure registers**
  - **Given** an agent worktree ensure succeeds
  - **When** the registry is listed
  - **Then** an entry kind=agent exists for that path
- [ ] **Scenario: remove via engine**
  - **Given** an unoccupied managed worktree
  - **When** `remove_worktree` / engine remove runs
  - **Then** git worktree is removed and registry entry is gone; no raw prune path needed for that case
- [ ] **Scenario: fail-closed occupied**
  - **Given** a worktree occupied by a live agent cwd
  - **When** remove is requested
  - **Then** remove fails without deleting
- [ ] GitDelivery prune worktree removal goes through WorktreeManager/engine, not ad-hoc argv only
- [ ] Unit tests cover registry pure ops + service create/list/remove

**Verify:** `npx vitest run test/unit/managedWorktree.test.ts test/unit/workspaceFolderOps.test.ts --reporter=dot`
**Dogfood-Opt-Out:** Bridge tools require installed host dogfood; unit coverage proves registry/engine in CI.

## Closure

_(filled on ship)_

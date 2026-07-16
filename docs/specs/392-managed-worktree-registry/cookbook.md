# Cookbook — managed worktree registry (spec 392)

Operator/agent how-to for Tachyon **managed worktrees**. Contract: [`spec.md`](./spec.md).

## When to use

- You need an isolated **change** checkout (task/feature) under the canonical base, registered so multi-root reveal can see it.
- You need to **list / get / remove** Tachyon-owned checkouts without inventing sibling paths under the repo.
- GitDelivery prune or UI cleanup should go through the engine (occupancy fail-closed).

## When not to use

- Do **not** spawn a second Bridge/tmux in the change folder — folders are view-only in multi-root.
- Do **not** use this for Delivery/verify hermetic clones (different subsystem).
- Agent checkouts for spawn still go through agent ensure/fork; the registry **syncs** them automatically.

## Paths

Base (default): `~/.cache/tachyon/worktrees` (override: `settings.worktree.base`).

```text
<base>/<wsHash>/
  ├── <agentName>/           # kind=agent
  └── change/<slug>/         # kind=change
```

Registry file (workspace): `.tachyon/managed-worktrees.json`  
Statuses: `active` | `abandoned` (missing on-disk paths reconcile to abandoned on list/get).

## Happy path — change worktree

1. **Create** (Bridge, authenticated agent/human):
   - Tool: `create_worktree`
   - Args: `{ "kind": "change", "slug": "t-689e6c", "taskId": "t-689e6c" }` (taskId optional)
   - Result: git worktree at `<base>/<wsHash>/change/<slug>`, branch `tachyon/change/<slug>`, registry row `kind=change`.
2. **List**: `list_worktrees` → registry entries (filter `kind` / `status` optional).
3. **Get**: `get_worktree` with `idOrPath`.
4. **Work** in that path (editor multi-root reveal via `worktrees.list` merge).
5. **Remove** when done: `remove_worktree` with `{ "idOrPath": "<id or abs path>" }`.
   - Clean tree → soft git remove.
   - Dirty → pass `"confirmDirty": true`.
   - Occupied by a live agent cwd → **refused** (even with confirmDirty).

## Tools

| Action | Bridge tool | Notes |
|--------|-------------|-------|
| Create change | `create_worktree` | v1: `kind=change` only |
| List | `list_worktrees` | agent + change |
| Get | `get_worktree` | id or absolute path |
| Adopt existing | `register_worktree` | path must be under managed root; validates git common-dir |
| Drop catalog only | `unregister_worktree` | does not delete git worktree |
| Delete worktree | `remove_worktree` | occupancy fail-closed; dirty needs `confirmDirty` |

## Authorization

| Caller | Mutate/remove |
|--------|----------------|
| Entry `createdBy` / agent owner | yes |
| Other agent | **no** |
| Human host principal | yes |
| Shared legacy/external token | **not** privileged |

Agents may only **register** their own canonical path (no peer path takeover).

## Fail-closed

- **Occupancy**: live agent with cwd under the worktree → remove refused (manager + GitDelivery prune; abandon does **not** override).
- **Dirty (Bridge)**: requires `confirmDirty=true`.
- **Registry**: corrupt/unknown schema fails closed (no silent wipe).
- **Missing path**: list/get marks `abandoned`; reappearance is **not** auto-active — re-`register_worktree` to revalidate identity.

## Cleanup

1. Prefer `remove_worktree` so git + registry stay consistent.
2. If git exists but registry is gone: `register_worktree` then remove, or manual `git worktree remove` + prune (last resort).
3. If registry row is abandoned and path is gone: `unregister_worktree` to drop the row.

## Agent sync

Spawn/ensure/fork that creates or clears an agent worktree updates the registry via `syncAgentRecord` — no manual register for normal agent lifecycle.

## See also

- Spec 392 contract: [`spec.md`](./spec.md)
- Implementation: `src/worktree/managedWorktree.ts`, `ManagedWorktreeService.ts`, `WorktreeManager.ts`, Bridge tools in `src/bridge/tools.ts`

# Plan 392 — Managed worktree registry

## Approach

1. **`ManagedWorktreeEntry` + file store** at `.tachyon/managed-worktrees.json` (workspace-local).
2. **`ManagedWorktreeService`** uses existing `WorktreeManager` git primitives (`gitArgs`, locks, remove/occupancy) for mutate ops; does not reimplement quarantine launch for change worktrees (simple add/remove).
3. **Hook** `WorktreeManager.ensure` / `createFork` / `remove` success → registry upsert/delete via optional callback or explicit service calls from Workspace.
4. **Bridge tools** on `BridgeDeps.managedWorktrees`.
5. **`worktrees.list`** / reveal merge agent records + registry change entries.
6. **Migrate** `git-delivery/prune.ts` to `deps.removeManagedWorktree(path)` implemented via manager.remove or service.

## Key decisions

- **Same base** as agent worktrees (`resolveBase`) with path layout:
  - agent: `<base>/<wsHash>/<agent>` (unchanged)
  - change: `<base>/<wsHash>/change/<slug>`
- **WorktreeManager remains the git engine** for agent lifecycle; service is the product façade + change kind + registry.
- **Slug safety**: `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$` for change ids.

## Files

- `src/worktree/managedWorktree.ts` (new)
- `src/worktree/ManagedWorktreeService.ts` (new)
- `src/worktree/WorktreeManager.ts` (optional onRegister hooks; public force-remove path helper)
- `src/bridge/tools.ts` (tools)
- `src/workspace/Workspace.ts` (wire service)
- `src/git-delivery/prune.ts` (migrate remove)
- `src/extension.ts` / engine worktrees.list (reveal merge)
- `test/unit/managedWorktree.test.ts`

## Risks

- Registry drift vs git → list reconciles missing paths as abandoned
- Single-folder VS Code still cannot reveal (existing limitation)

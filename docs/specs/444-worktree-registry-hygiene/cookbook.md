# 444 — worktree-registry-hygiene — cookbook

Operator how-to for the worktree hygiene surface. The contract lives in [`spec.md`](./spec.md);
this is the happy path.

## When to use

- You want to know which managed worktrees are safe to clean up, and why the others aren't.
- You want to clear registry tombstones (rows whose checkout directory is gone).
- You're an agent that needs the same classification the Control tab shows.

## When NOT to use

- GitDelivery-tracked ad-hoc spawn worktrees have their own richer lifecycle — use
  `git_delivery_list` / `git_delivery_hygiene` / `git_delivery_prune` (spec 365) for those.
- Removing an agent's worktree as part of killing the agent — that's Fleet's kill flow
  (`worktree.remove`, agent-name-scoped), not this surface.

## Human happy path (Control → Worktrees)

1. Open Control → **Worktrees**. Rows are grouped by a live, fail-closed classification —
   recomputed on every open, never cached:
   - **Ready to remove** — clean, unoccupied, zero commits not already in its base. Safe.
   - **Needs review** — blocked, with the reason inline (dirty / commits not in base / probe failed).
   - **Occupied** — a live agent holds it; nothing destructive is offered.
   - **Record-only** — tombstone; the directory is gone. Only `Forget record` is offered.
2. Single actions: `Remove checkout` (ready group; optional per-click "Also delete local branch",
   shown only for Tachyon-created branches), `Forget record` (record-only group).
3. Batch: select rows in the two safe groups → `Review & confirm…` → `Run cleanup`. Every item is
   re-validated at execution; one whose state changed since you selected it is skipped with its
   reason (toast), the rest proceed.
4. Engine down? The tab shows an error state instead of rows — unverified data is never displayed.

## Agent surface (Bridge tools)

| Tool | What it does | Cost |
|---|---|---|
| `list_worktrees` | Registry rows only (identity fields). | Cheap — use on hot paths. |
| `worktree_audit` | Rows + the same classification the tab shows (`state`, `reasons`, `dirty`, `aheadOfBase`, `containedInBase`, `occupant`). | Git probes per row — opt-in. |
| `remove_worktree` | Remove a checkout by id/path. Occupancy fail-closed; dirty needs `confirmDirty`; `deleteBranch` only for Tachyon-created branches. | — |
| `unregister_worktree` | Forget a registry row (disk untouched). Ownership-gated. | — |

Typical agent flow: `worktree_audit` → act only on `ready-to-remove` (via `remove_worktree`)
or `record-only` (via `unregister_worktree`); treat everything else as hands-off.

## Fail-closed rules (what the system will refuse)

- A probe failure (git/status unreadable) classifies `needs-review`, never `ready-to-remove`.
- Removal re-validates occupancy and dirtiness at execution — a stale "ready" verdict is refused,
  not honored.
- Local branch deletion happens only with explicit consent AND `tachyonCreatedBranch`; git's own
  safe-delete additionally refuses unmerged branches. No remote branch is ever touched (PI-002).

## Cleanup

Forgetting a record does not delete anything on disk. If a forgotten path later matters again,
`register_worktree` re-validates and re-adopts it.

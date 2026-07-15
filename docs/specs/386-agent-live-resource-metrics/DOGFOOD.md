# 386 — dogfood (EDH)

## Build

```bash
cd /home/goat/tachyon-worktrees/agent-live-resource-metrics
npm run build   # node_modules may be symlink to monorepo
```

## Point monorepo F5 (required)

```bash
cd /home/goat/tachyon
npm run dogfood:dev-host -- point \
  --worktree /home/goat/tachyon-worktrees/agent-live-resource-metrics \
  --workspace /home/goat/tachyon \
  --spec 386 --slug agent-live-resource-metrics
```

Then **Run and Debug → Tachyon: Dev Host → F5**.

Or open the monorepo fleet window with extension from this worktree via the point.

## Check

1. Running agents show peek `N% · XM` (after ~1–2 fleet refreshes for CPU%).
2. ▤ expands L3 CPU + L4 Mem; tree ▾ still only collapses children.
3. Expand metrics / Collapse metrics in Agents header.
4. Hover toolbar does not cover the name (gutter).
5. Stopped agents: no peek / no ▤.

## Cleanup

```bash
cd /home/goat/tachyon
npm run dogfood:dev-host -- point-clear
```

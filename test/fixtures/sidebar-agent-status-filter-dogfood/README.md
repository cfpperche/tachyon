# sidebar-agent-status-filter dogfood (t-eddf90)

Isolated workspace for **Tachyon: Dev Host** F5 validation of Agents status filter chips.

## Setup (agent)

From monorepo root after the feature branch is built in the worktree:

```bash
npm run dogfood:dev-host -- point \
  --worktree /home/goat/tachyon-worktrees/t-eddf90-sidebar-agent-status-filter \
  --workspace /home/goat/tachyon-worktrees/t-eddf90-sidebar-agent-status-filter/test/fixtures/sidebar-agent-status-filter-dogfood \
  --spec t-eddf90 \
  --slug sidebar-agent-status-filter \
  --owner grok-sidebar
```

## Human checklist

1. Monorepo window: Run and Debug → **Tachyon: Dev Host** → **F5**.
2. In the EDH window only: open the Tachyon sidebar → **Agents** tab.
3. Expect chips under `AGENTS`: **All · Live · Needs you · Stopped** with counts.
4. Start/stop agents from the sidebar (↻ / stop) and confirm:
   - **Live** shows only process-alive rows
   - **Stopped** shows hollow-dot / resumable cemetery
   - **Needs you** surfaces `needs` / `throttled` / `stop-failed` / awaiting-human
   - Re-click active chip or **Clear** returns to All
   - Chip counts stay anchored to the full fleet (not the filtered subset)
5. Confirm sort A–Z still works under a filter (no status regroup).

When done: `npm run dogfood:dev-host -- point-clear`

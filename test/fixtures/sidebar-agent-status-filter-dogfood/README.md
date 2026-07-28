# sidebar-agent-status-filter dogfood (t-eddf90)

Isolated workspace for **Tachyon: Dev Host** F5 validation of the Agents status-filter dropdown.

> **Create the agents first (SDD 478).** This fixture declares no agents. An `agents:` entry is a
> pointer to a canonical profile, and the authority that attests it is custodied by the host (VS Code
> secret storage), so no checked-in fixture can ship one. After arming the Dev Host, create the rows
> below with **Tachyon: Agent Studio**, then continue.

> The chips need a mixed roster, so create a few agents (any attested runtime) and leave some
> stopped. The fixture's `terminals:` supply the non-agent half. The old rows were `bash` with
> `kind: agent` forced on — a process cannot be an agent, so that shape is gone.

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
3. Expect a compact dropdown in the `AGENTS` title toolbar with **All · Live · Needs you · Stopped · On task · Has focus**, each with its count.
4. Start/stop agents from the sidebar (↻ / stop) and confirm:
   - **Live** shows only process-alive rows
   - **Stopped** shows hollow-dot / resumable cemetery
   - **Needs you** surfaces `needs` / `throttled` / `stop-failed` / awaiting-human
   - Select **All** to return to the unfiltered fleet
   - Dropdown counts stay anchored to the full fleet (not the filtered subset)
5. Confirm sort A–Z still works under a filter (no status regroup).

When done: `npm run dogfood:dev-host -- point-clear`

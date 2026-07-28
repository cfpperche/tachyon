# Prompt templates dogfood fixture (spec 381)

Isolated temporary workspace for **Tachyon: Dev Host** (Extension Development Host).

> **Create the agents first (SDD 478).** This fixture declares no agents. An `agents:` entry is a
> pointer to a canonical profile, and the authority that attests it is custodied by the host (VS Code
> secret storage), so no checked-in fixture can ship one. After arming the Dev Host, create the rows
> below with **Tachyon: Agent Studio**, then continue.

> Inject Prompt Template offers AGENTS only, so create at least one (`claude` or `codex`) to be the
> destination. The `shell` terminal is the negative case: it must NOT appear in the picker. The old
> `dogfood` row was `bash` with `kind: agent` forced on precisely so the picker would accept it —
> that shape is gone, so proving the picker now needs a real agent.

## How to run (from monorepo)

```bash
# monorepo root — once per session (agent or human)
npm run dogfood:dev-host -- point \
  --worktree /home/goat/tachyon-worktrees/prompt-templates \
  --workspace /home/goat/tachyon-worktrees/prompt-templates/test/fixtures/prompt-templates-dogfood \
  --spec 381 --slug prompt-templates
```

Then in the monorepo VS Code window:

1. Run and Debug → **Tachyon: Dev Host**
2. **F5**
3. In the **EDH window** (not the parent):
   - Wait for sidebar agent `dogfood` (autostart)
   - Command Palette → **Tachyon: Inject Prompt Template…**
   - Stage a template into `dogfood` (body without Enter)
4. Close EDH when done. Optional: `npm run dogfood:dev-host -- clear`

## Templates on disk

```text
.tachyon/prompts/status-next.md
.tachyon/prompts/review-auth.md
.tachyon/prompts/check-report.md
```

## Isolation

Dev Host uses private user-data / extensions / tmux / cache under monorepo
`.tachyon/dev-host/`. This fixture is never the monorepo fleet `tachyon.yml`.

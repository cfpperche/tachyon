# Prompt templates dogfood fixture (spec 381)

Isolated temporary workspace for **Tachyon: Dev Host** (Extension Development Host).

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

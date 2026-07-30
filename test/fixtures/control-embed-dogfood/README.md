# control-embed-dogfood

> **Create the agents first (SDD 478).** This fixture declares no agents. An `agents:` entry is a
> pointer to a canonical profile, and the authority that attests it is custodied by the host (VS Code
> secret storage), so no checked-in fixture can ship one. After arming the Dev Host, create the rows
> below with **Tachyon: Agent Studio**, then continue.

Dogfood fixture for spec control-monolith-embed — **intent: focus**.

## Intent presets

| Intent | When to use | Agents |
|--------|-------------|--------|
| **focus** | Sidebar focus line / filters; Live 0 is OK | stopped agents + task/continuity seeds |
| **metrics** | CPU/MEM peek (spec 386) | autostart busy loops — need **Live > 0** |

This fixture was scaffolded as **focus**.

## Git note

Repo `.gitignore` ignores `.tachyon/`. Force-add seed content:

```bash
git add -f test/fixtures/control-embed-dogfood/.tachyon
git add test/fixtures/control-embed-dogfood/tachyon.yml test/fixtures/control-embed-dogfood/README.md
```

## Arm Dev Host

```bash
# from monorepo:
npm run dogfood -- dev-host -- point \
  --worktree <worktree-or-repo> \
  --fixture control-embed \
  --spec control-monolith-embed --slug control-embed
```

Human: **Run and Debug → Tachyon: Dev Host → F5**. Then `point-clear` when done.
If you remove the worktree, run `point-clear` so the pointer is not left stale.

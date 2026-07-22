# release-0-56-91-dogfood

Dogfood fixture for spec 410 — **intent: focus**.

## Intent presets

| Intent | When to use | Agents |
|--------|-------------|--------|
| **focus** | Sidebar focus line / filters; Live 0 is OK | stopped agents + task/continuity seeds |
| **metrics** | CPU/MEM peek (spec 386) | autostart busy loops — need **Live > 0** |

This fixture was scaffolded as **focus**.

## Git note

Repo `.gitignore` ignores `.tachyon/`. Force-add seed content:

```bash
git add -f test/fixtures/release-0-56-91-dogfood/.tachyon
git add test/fixtures/release-0-56-91-dogfood/tachyon.yml test/fixtures/release-0-56-91-dogfood/README.md
```

## Arm Dev Host

```bash
# from monorepo:
npm run dogfood:dev-host -- point \
  --worktree <worktree-or-repo> \
  --fixture release-0-56-91 \
  --spec 410 --slug release-0-56-91
```

Human: **Run and Debug → Tachyon: Dev Host → F5**. Then `point-clear` when done.
If you remove the worktree, run `point-clear` so the pointer is not left stale.

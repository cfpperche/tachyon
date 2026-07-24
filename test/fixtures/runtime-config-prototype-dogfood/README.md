# runtime-config-prototype-dogfood

Dogfood fixture for SDD 446/447 — Runtime Config's controlled Codex inventory and editor.

It contains two stopped Codex agents plus two deliberately different Codex sources. In the
Dev Host, open **Control → Runtime Config** and inspect both scopes:

- **Workspace** shows `.codex/config.toml`: `on-request`, `workspace-write`, pragmatic,
  true booleans, MCPs `fixture_keep` / `fixture_remove`, `model` / notice as Other keys.
- **Global** is a Dev Host-private copy of `.runtime-config-global-home/.codex/config.toml`:
  `never`, `danger-full-access`, focused, false booleans, the same named MCPs and a hidden
  `hooks.state` record. It never reads or writes the machine's real `~/.codex/config.toml`.

## Slice B walkthrough

1. In **Workspace**, change `Approval policy`, save, then open the source file: only that line changes.
2. In **Global**, change a different measured field and confirm the workspace source is untouched.
3. Disable `fixture_remove`; its block disappears while `fixture_keep`, comments and Other keys remain.
4. Reload the page after an external edit before saving again: Runtime Config must refuse a stale revision.

## Intent presets

| Intent | When to use | Agents |
|--------|-------------|--------|
| **focus** | Sidebar focus line / filters; Live 0 is OK | stopped agents + task/continuity seeds |
| **metrics** | CPU/MEM peek (spec 386) | autostart busy loops — need **Live > 0** |

This fixture was scaffolded as **focus**.

## Git note

Repo `.gitignore` ignores `.tachyon/`. Force-add seed content:

```bash
git add -f test/fixtures/runtime-config-prototype-dogfood/.tachyon
git add test/fixtures/runtime-config-prototype-dogfood/tachyon.yml test/fixtures/runtime-config-prototype-dogfood/README.md
```

## Arm Dev Host

```bash
# from monorepo:
npm run dogfood:dev-host -- point \
  --worktree <worktree-or-repo> \
  --fixture runtime-config-prototype \
  --spec 442 --slug runtime-config-prototype
```

Human: **Run and Debug → Tachyon: Dev Host → F5**. Then `point-clear` when done.
If you remove the worktree, run `point-clear` so the pointer is not left stale.

# runtime-config-prototype-dogfood

Dogfood fixture for SDD 446/447/464 — Runtime Config's controlled Codex and Claude inventory/editor.

It contains two stopped Codex agents plus two deliberately different Codex sources. In the
Dev Host, open **Control → Runtime Config** and inspect both scopes:

- **Workspace** shows `.codex/config.toml`: `on-request`, `workspace-write`, pragmatic,
  true booleans, MCPs `fixture_keep` / `fixture_remove`, `model` / notice as Other keys.
- **Global** is a Dev Host-private copy of `.runtime-config-global-home/.codex/config.toml`:
  `never`, `danger-full-access`, focused, false booleans, the same named MCPs and a hidden
  `hooks.state` record. It never reads or writes the machine's real `~/.codex/config.toml`.

Claude adds three independently versioned documents:

- **Global settings** uses the Dev Host-private `.runtime-config-global-home/.claude/settings.json`.
- **Workspace settings** exposes measured scalars, summarizes hooks opaquely and marks
  `prefersReducedMotion` shadowed by `settings.local.json`.
- **Workspace MCP** exposes only the server name from `.mcp.json`; command payloads stay hidden.

Grok (SDD 481) adds three more, and is the runtime whose documents do **not** share one blast radius:

- **Global config** is the Dev Host-private `.runtime-config-global-home/.grok/config.toml`. It shows
  the measured scalars (including numeric ones), `ui.permission_mode` as **read-only** with a stated
  reason, and states that Tachyon-managed Grok agents do not inherit it.
- **Workspace config** (`.grok/config.toml`) offers **no** scalar editor: Grok reads only
  `[mcp_servers]` in project scope, and the fixture's inert `[models]` section is listed as ignored.
- **Folder trust** (`.runtime-config-global-home/.grok/trusted_folders.toml`) deliberately does not
  trust this workspace, so it must read "Not decided" and offer nothing to save.

Every Grok fixture value that would be a payload is spelled `fixture-never-render-…`, so a leak into
the DOM is a visible test failure rather than a judgement call.

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
scripts/dev-host/cli.sh point \
  --worktree <worktree-or-repo> \
  --fixture runtime-config-prototype \
  --spec 442 --slug runtime-config-prototype
```

Human: **Run and Debug → Tachyon: Dev Host → F5**. Then `point-clear` when done.
If you remove the worktree, run `point-clear` so the pointer is not left stale.

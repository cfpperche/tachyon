# 393 — notes

## Worktree

| | |
|--|--|
| Path | `/home/goat/tachyon-worktrees/dev-host-dogfood-ergonomics` |
| Branch | `grok/dev-host-dogfood-ergonomics` |
| Base | `main` @ `f3c81ea3` (merge 390) |

## Origin

Conversation after 390 land + cleanup: “does Dev Host process need improvements?” → P0–P3 list → open small spec + isolated worktree.

## In-flight memory

### Implemented (2026-07-16)

- **P0:** `materializeWorkspaceMirror` already copies `.tachyon`; unit test asserts non-symlink; `status()` doctor fields + `printStatus`; runbook symlink/copy table.
- **P1:** `resolveFixturePath`, `point --fixture`, `fixture-new` (focus|metrics), CLI `fixture-new`.
- **P2:** `argvWrapperScript` falls back via `git rev-parse --git-common-dir`; `ensureWorktreeToolBin` on `point` for existing leaves; stale worktree → broken status.
- **P3:** `fixtureDrift` warning; preferred F5 path in runbook/help; lease documented as delegated-only.

### Slug resolution

Worktree `test/fixtures/<slug>` wins over monorepo when both exist (worktree listed first in candidates).

### Hooks

New leaves get resolve-on-exec. Already-installed content-addressed leaves keep old scripts until plugin reinstall; `point` still symlinks monorepo `.tachyon/bin` into the worktree for those.

## Dogfood log

### 2026-07-16 CLI smoke (headless)

```text
fixture-new --slug ergonomics-smoke --intent focus → ok
point --fixture ergonomics-smoke → armed; mirror .tachyon real directory
point-status → doctor lines + dist/ missing warn (expected pre-build)
point-clear → cleared
```

Unit: `devHostPointer` 10 + `pluginGitHookRegistry` 9 + dispatcher 6 = green.

Commit on branch: `08443142`.

## Open

- Reinstall/regenerate hooks on main fleet if we want all leaves updated without relying on bin symlink.
- Human F5 glance optional before land.
- Land: merge branch → main (not done yet).

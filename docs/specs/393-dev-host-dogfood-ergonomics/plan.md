# 393 — plan

## Approach

Harden the existing Dev Host **pointer + fixture** stack in place (`scripts/dev-host/pointer.mjs`, `cli.sh`, unit tests, runbook). No new subsystem. Ship by priority band so P0 can land alone if needed.

## Key decisions

| Decision | Choice | Rejected |
|----------|--------|----------|
| Scope | Scripts + docs + tests only | Extension host / product UI changes |
| `.tachyon` mirror | Keep **cpSync** (landed in 390); lock with unit test + status check | Full fixture deep-copy (loses live yml edit via symlink) |
| Status UX | Enrich `point-status` (and shared status object) with doctor fields | Separate `point-doctor` binary (extra entry) |
| Fixture arm | `--fixture <slug>` resolves under worktree or monorepo `test/fixtures/` | Only absolute `--workspace` forever |
| Scaffold | Subcommand on `dogfood:dev-host` generating standard tree | Doc-only template without generator |
| Hooks | Resolve `_tachyon-tool` from primary checkout / `git rev-parse --git-common-dir` relative layout | Document “manually symlink bin” forever |
| P3 | Optional / shipped-partial OK | Block close on drift re-materialize |

## Sources (grounding)

- `scripts/dev-host/pointer.mjs` — `materializeWorkspaceMirror` already copies `.tachyon`
- `test/unit/devHostPointer.test.ts` — asserts mirror is real dir + child symlinks; **does not yet** assert `.tachyon` is non-symlink
- `docs/runbooks/dev-host.md` — F5 pointer section; still describes “child symlinks” without copy exception table
- `scripts/dev-host/cli.sh` — `point` / `point-status` / `point-clear` / `seed` / `launch` / `headless`
- Spec 390 dogfood: SoulError, Live 0 metrics surprise, force-add fixture `.tachyon`, worktree hook fail

## Files likely touched

| Area | Paths |
|------|--------|
| Pointer | `scripts/dev-host/pointer.mjs`, `pointer.d.mts` |
| CLI | `scripts/dev-host/cli.sh` |
| Tests | `test/unit/devHostPointer.test.ts` (+ new fixture scaffold tests if any) |
| Runbook | `docs/runbooks/dev-host.md` |
| Hooks (P2) | `.tachyon/githooks/leaves/*` generators and/or tool path resolution in managed hook install — **read first** how leaves are generated |
| Scaffold (P1) | new helper under `scripts/dev-host/` or inline in `cli.sh` |

## Risks

| Risk | Mitigation |
|------|------------|
| Breaking WSL F5 by over-copying | Keep only `.tachyon` as real dir; other children stay symlinks |
| Hook regeneration overwrites leaf fix | Fix generator or install path, not a one-off leaf edit if leaves are generated |
| Fixture slug ambiguity | Document resolution order: worktree `test/fixtures/<slug>` then monorepo |
| Scope creep into lease system | P3 auto-lease deferred; document only |

## Implementation order

1. **P0** tests + status fields + runbook table  
2. **P1** `--fixture` resolve + `fixture-new` + preset docs in scaffold README  
3. **P2** hook resolution + stale worktree status  
4. **P3** as time allows: drift warning, runbook preferred-path fold  

## Visual QA

**Visual QA Opt-Out:** CLI/runbook/tests only — no product webview or VS Code UI chrome changes.

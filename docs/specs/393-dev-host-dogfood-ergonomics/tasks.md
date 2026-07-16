# 393 — tasks

**Verify:** `npx vitest run test/unit/devHostPointer.test.ts test/unit/pluginGitHookRegistry.test.ts`  
**Dogfood:** `npm run dogfood:dev-host -- fixture-new --slug ergonomics-smoke --intent focus && npm run dogfood:dev-host -- point --worktree "$PWD" --fixture ergonomics-smoke --spec 393 && npm run dogfood:dev-host -- point-status && npm run dogfood:dev-host -- point-clear`  
**Human dogfood:** arm pointer → F5 Dev Host → `point-status` doctor lines → `point-clear`  
**Visual QA Opt-Out:** scripts/docs only

## P0 — harden mirror + status + docs

- [x] Unit test: mirror `.tachyon` is **not** a symlink; seed file readable under mirror
- [x] `status` / `point-status` prints: extension realpath, workspace mirror, `.tachyon` real?, worktree exists?, `dist/` hint
- [x] Nonzero or explicit `broken: true` when worktree path missing
- [x] Runbook: symlink-vs-copy table + SoulError recovery one-liner
- [x] Align runbook F5 section with post-390 mirror behavior

## P1 — fixture + point ergonomics

- [x] `point --fixture <slug>` resolves `test/fixtures/<slug>` or `*-dogfood` under worktree (fallback monorepo)
- [x] CLI help documents `--fixture`
- [x] `fixture-new --slug … --spec …` scaffolds yml + README + `.tachyon` skeleton
- [x] Scaffold README lists **focus** vs **metrics** intent presets
- [x] Unit or smoke test for fixture path resolution

## P2 — worktree hooks + lifecycle

- [x] Investigate how githook leaves resolve `_tachyon-tool` (generated vs static)
- [x] Fix so isolated worktree commits do not need manual `.tachyon/bin` symlink (`argvWrapperScript` fallback + `point` links bin)
- [x] `point-status` clearly broken when meta worktree path gone
- [x] Notes/runbook: after `git worktree remove`, run `point-clear` if that worktree was pointed

## P3 — polish (optional / shipped-partial OK)

- [x] Warn if mirror `.tachyon` mtime older than fixture `.tachyon` (status `fixtureDrift`)
- [x] Runbook: single preferred human path (F5 pointer); demote seed/launch to secondary without deleting
- [x] Auto-lease for F5: document only (“lease for delegated GUI/headless”)

## Close

- [x] Verify command green (on branch)
- [x] Dogfood log or Human dogfood note in `notes.md`
- [x] Status → shipped; **Closure:** line

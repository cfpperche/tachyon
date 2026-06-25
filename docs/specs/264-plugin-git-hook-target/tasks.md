# 264 — plugin-git-hook-target — tasks

_Generated from `plan.md` on 2026-06-25. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. **manifest — `gitHooks` declaration.** Add optional top-level `gitHooks?: { "pre-commit": { leaf: <payload-path> } | { argv: string[] } }` to `PluginManifest`; v1 rejects any event ≠ `pre-commit`; validate the leaf as a contained payload path (mirror `validBlockPath`: no traversal/abs/controls/backslash) or a non-empty `argv` (no shell). Unknown-field + fail-closed parse. Unit tests.
- [x] 2. **gitRepo.ts — worktree-correct introspection.** New module on the `GitRun` pattern: `hookPath(event)` via `git rev-parse --git-path hooks/<event>`, `commonDir()`, `topLevel()`; `getHooksPath()`/`setHooksPath()`/`unsetHooksPath()` (raw + repo-root-resolved); `worktreeConfigEnabled()`. Refuse (typed error) when per-worktree config is on. Unit tests against a REAL temp git repo incl. a linked worktree.
- [x] 3. **gitHookRegistry.ts — managed dir primitives.** `.tachyon/githooks/`: content-addressed `leaves/<hash>` store; immutable registry snapshot read/write with an integrity hash (atomic publish, never references a missing leaf); `ownership.json` (`claimedFrom`, `managedPath`, `leafRefs` across all events, `generation`); a repo lock (acquire/release). Pure I/O, fail-closed reads. Unit tests.
- [x] 4. **gitHookRegistry.ts — generated dispatcher.** Emit the Tachyon-authored POSIX `sh` `pre-commit` dispatcher: integrity self-validate (fail-closed), preserve Git env (+ `TACHYON_` additions only), run prior user hook first then each leaf in canonical-id order (argv via direct spawn, no shell/PATH), run-all-aggregate, propagate exit; missing/non-exec leaf fail-closed. Unit + a test asserting the emitted script's behavior by executing it.
- [x] 5. **lockfile — `PluginLock.gitHooks`.** Add the parallel optional `gitHooks?: { event, managedLeafPath, leafContentHash, ownershipGeneration }[]`; parse/validate fail-closed (contained paths, hex hash); old locks without it tolerated. Unit tests (round-trip, fail-closed, absent-tolerant).
- [x] 6. **engine — load + plan + preview + fingerprint.** `loadPlugin` discovers/validates `gitHooks` (leaf payload exists); `planGitHookTargets`; `previewInstall` adds a `gitHookTargets` surface; bind into `fingerprintOf`: `core.hooksPath` (raw+resolved) + resolved prior-hook identity (kind/path/exec-bit/type/content-hash/config-scope) + registered-leaf set + ownership generation. Unit tests incl. "fingerprint changes when hooksPath or prior hook drifts".
- [ ] 7. **engine — applyInstall (transactional).** Under the repo lock: write leaf to the store, publish a new complete snapshot, ensure the dispatcher, capture the prior hook, set `core.hooksPath` LAST via the ownership record (bump generation); roll back on any failure leaving prior state intact. Record `PluginLock.gitHooks`. Tests on a real temp git repo.
- [ ] 8. **engine — applyRemove + restore.** Un-register by removal identity; restore `core.hooksPath` to `claimedFrom` ONLY when `leafRefs == 0` across all events AND `current == managedPath`; cleanup empty Tachyon dirs; never touch the user's hook. Tests: two plugins (refcount), prior-hook present (restore-to-prior), user changed hooksPath after install (don't restore).
- [ ] 9. **engine — repair + clone behavior.** A `repairGitHooks` entry: lockfile records a git-hook but the managed dir/registry is absent (clone) ⇒ do NOT claim `core.hooksPath` until an explicit repair-under-consent. Tests: cloned-lockfile state stays inert; repair re-claims.
- [ ] 10. **dispatcher — live behavior against a real commit.** Integration test: install into a temp git repo, run an actual `git commit` (and a failing leaf, a passing leaf, a prior user hook, two plugins, a path with a space); assert blocking, exit propagation, env/args/stdin, run-all-aggregate, fail-closed on a tampered registry. Confirm `--no-verify` bypasses (documented, not prevented).
- [ ] 11. **consent VM + UI + panel wiring.** `consentViewModel`: a git-hook section + a dedicated "runs on every commit, for everyone" ack (exact command + data-access + `--no-verify` note + restoration). `App.tsx` renders it + gates confirm on the ack. `PluginsPanel`: thread git-hook through preview/confirm/remove + the repair path. View-model unit tests; webview build green.

## Verification

_Acceptance checks tied to `spec.md`. Each maps to a scenario there._

- [ ] A pre-commit git-hook materializes (leaf in the store, dispatcher present, `core.hooksPath` claimed via the ownership record) — scenarios 1–2
- [ ] Worktree-correct paths (main + linked worktree); refuse on `extensions.worktreeConfig` — worktree scenario
- [ ] Prior-hook capture (executable, non-`.sample`, regular file) + chained first, exit preserved — prior-hook + coexist scenarios
- [ ] Multiple plugins coexist; run-all-aggregate; blocks iff any non-zero — coexist + gate scenarios
- [ ] Dedicated consent ack surfaces data-access + bypass + restoration — consent scenario
- [ ] Removal identity round-trips; uninstall un-registers exactly + restores prior `core.hooksPath` only on refs==0-across-events && current==managed — lockfile + uninstall scenarios
- [ ] `--no-verify` documented as a user bypass (not prevented) — gate scenario
- [ ] Transactional install + repo lock (no half-installed); clone state inert until repair — transactional + clone scenarios
- [ ] Concurrency: install/remove serialize; dispatcher reads an integrity-validated immutable snapshot — concurrency scenario
- [ ] TOCTOU fingerprint binds hooksPath(raw+resolved)+prior-hook identity+leaf set+generation — TOCTOU scenario
- [ ] Manifest leaf constraints reject traversal/shell-eval; argv runs via direct spawn — manifest-constraints + dispatcher

**Headless check:** `env -u TMUX npx vitest run && npm run -s typecheck && node esbuild.mjs`

**Human approval:** opt-in — install a pre-commit git-hook plugin into a real repo via the Plugins View; make a commit that the leaf blocks (non-zero) and one it passes; confirm the prior hook still runs; remove and confirm `core.hooksPath` is restored to its prior value and the user's own hook is untouched.

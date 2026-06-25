# 264 — plugin-git-hook-target — plan

_Drafted from `spec.md` (codex round-1 + round-2 folded) on 2026-06-25. The approach, not the steps._

## Approach

A git-hook is **runtime-agnostic** (it fires for every actor, not through a runtime), so it does NOT slot into the per-runtime `blocks` model — it is a new top-level manifest declaration + a new lockfile record + new managed infrastructure, integrated into the existing preview→consent→apply→remove engine (specs 250/263) so it reuses the fingerprint/lockfile/consent machinery rather than a side channel.

Five layers, bottom-up:

1. **Manifest declaration.** Add an OPTIONAL top-level `gitHooks?: { "pre-commit": { leaf } }` to `PluginManifest` (`src/plugins/manifest.ts`). v1 accepts only the `pre-commit` event; `leaf` is either a contained plugin-payload path or a declared `argv` array (no shell string). Fail-closed validation mirrors `validBlockPath` (containment, no traversal, no controls).

2. **Git repo layer** — new `src/plugins/gitRepo.ts`, built on the existing `GitRun` pattern (`fetcher.ts`) and the git-exec style in `WorktreeManager.ts`. Pure-ish wrappers, all worktree-correct: `gitPath("hooks/<event>")` via `git rev-parse --git-path`, `--git-common-dir`, `--show-toplevel`; read/write `core.hooksPath` (raw + repo-root-resolved); detect `extensions.worktreeConfig` (write correct scope or **refuse**). No hardcoded `.git/hooks`.

3. **Managed git-hook infrastructure** — new `src/plugins/gitHookRegistry.ts`, owner of `.tachyon/githooks/`:
   - **content-addressed leaf store** `leaves/<contentHash>` (copied from the verified payload).
   - **immutable registry snapshot** + integrity hash: an atomically-published file listing `{ event, pluginId, leafPath, contentHash, argv? }` per registered leaf + the captured prior-hook identity; never references a missing leaf.
   - **repo-level ownership record** `ownership.json`: `{ claimedFrom (prior core.hooksPath or none), managedPath, leafRefs (across ALL events), generation }`.
   - **generated dispatcher** per event (Tachyon-authored POSIX `sh`): self-validates the snapshot integrity (fail-closed), preserves Git's env exactly (+ only `TACHYON_`-namespaced additions), runs the prior user hook first then each leaf (argv via direct spawn, no shell/PATH) in canonical-plugin-id order, run-all-aggregate, propagates exit codes; a missing/non-exec leaf is fail-closed.
   - **repo lock** for install/remove (a lockfile under the managed dir).

4. **Lockfile** (`src/plugins/lockfile.ts`). `MaterializedTarget` requires a `runtime`, which a git-hook has none of → add a PARALLEL optional `gitHooks?: GitHookLock[]` to `PluginLock` (NOT shoehorned into `targets`): `{ event, managedLeafPath, leafContentHash, ownershipGeneration }` — the unambiguous removal identity (two plugins with identical leaf content don't collide). Parse/validate fail-closed; old locks without it tolerated.

5. **Engine integration** (`src/plugins/engine.ts`):
   - `loadPlugin`: discover + validate the `gitHooks` declaration (leaf payload exists, contained).
   - a `planGitHookTargets` (sibling of `planSkillTargets`) — per-event, not per-runtime.
   - `previewInstall`: include git-hook targets in the plan + a NEW `gitHook` consent surface; bind into `fingerprintOf`: `core.hooksPath` (raw+resolved), the resolved prior-hook identity (kind/path/exec-bit/type/content-hash/config-scope), the registered-leaf set, the ownership generation.
   - `applyInstall`: **transactional under the repo lock** — write the leaf to the content-addressed store, publish a new complete registry snapshot, ensure the dispatcher, capture the prior hook, and **set `core.hooksPath` LAST** (with the ownership record); roll back on failure.
   - `applyRemove`: un-register by removal identity; restore `core.hooksPath` to `claimedFrom` ONLY when `leafRefs == 0` across all events AND `current == managedPath`; cleanup empty dirs.
   - a `repair` entry the panel calls for a half-installed / freshly-cloned state (lockfile records a git-hook but the managed dir is absent → re-claim under consent).

6. **Consent VM + UI** (`src/plugins/consentViewModel.ts`, `src/webview/plugins/App.tsx`, `src/webview/PluginsPanel.ts`): a dedicated git-hook section + a separate "runs on every commit, for everyone" acknowledgement showing the exact command, data-access (reads staged content), the `--no-verify` bypass note, and the restoration behavior. Threaded through `PendingOp` + confirm like the MCP ack.

## Key decisions (from the spec, ratified)

- **Runtime-agnostic ⇒ a parallel `PluginLock.gitHooks` array**, not a `runtime`-bearing `targets` entry.
- **v1 = `pre-commit` only** (generic events deferred — message-arg forwarding).
- **Ownership record is repo-GLOBAL** (`.tachyon/githooks/ownership.json`), the lockfile is per-plugin — clean separation of "who owns hooksPath" vs "what this plugin registered".
- **Dispatcher is generated trusted code; leaves are content-addressed** (a tracked/writable payload must not mutate the executed script).
- **Transactional + repo lock; `core.hooksPath` set last; explicit `repair`** for half/clone state.

## Files touched

- `src/plugins/manifest.ts` — `gitHooks` field + validation.
- `src/plugins/gitRepo.ts` (new) — worktree-correct git introspection + `core.hooksPath` + worktreeConfig.
- `src/plugins/gitHookRegistry.ts` (new) — managed dir: leaf store, immutable snapshot, ownership record, generated dispatcher, repo lock.
- `src/plugins/lockfile.ts` — `PluginLock.gitHooks` removal identity.
- `src/plugins/engine.ts` — load/plan/preview(+fingerprint)/apply/remove/repair for git-hooks.
- `src/plugins/consentViewModel.ts` + `src/webview/plugins/App.tsx` + `src/webview/PluginsPanel.ts` — consent section + ack + wiring.
- `test/unit/*` + an integration test that runs the dispatcher against a REAL `git commit` in a temp repo.

## Risks & unknowns

- **`.tachyon/` is gitignored in this repo** (spec-263 follow-up), so the lockfile + managed dir are local-only here. The clone-behavior scenario already handles "lockfile records a git-hook but nothing is installed locally" (don't claim `core.hooksPath` until repair-under-consent). Interacts with — does not re-open — the "commit plugin state = user decision" follow-up.
- **Worktree config scope** (`extensions.worktreeConfig`): must be VERIFIED live against a real linked worktree (Tachyon agents use `WorktreeManager`), not assumed. Refuse rather than guess when per-worktree config is on.
- **The dispatcher must be proven against a real `git commit`** (env, args, stdin, exit aggregation, prior-hook chaining) — an integration test in a temp git repo, not just unit mocks.
- **Repo lock cross-process correctness** (a commit racing an install/remove) — atomic snapshot publish + the lock are the guard; test concurrent ops.
- **POSIX `sh` portability** + paths with spaces (Linux/WSL/macOS) — quote everything; test a repo path with a space.

## Sources consulted

- `src/plugins/engine.ts` — `loadPlugin` (358), `planSkillTargets` (496) / `planMcpTargets` (535), `previewInstall` (752), `applyInstall` (856), `applyRemove` (1211).
- `src/plugins/lockfile.ts` — `TargetKind` (19), `MaterializedTarget`.
- `src/plugins/fetcher.ts` — the `GitRun` exec pattern; `src/worktree/WorktreeManager.ts` — git usage in-repo.
- Codex review rounds 1 + 2 (folded in `spec.md` + `notes.md`).

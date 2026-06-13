# 210 — tachyon-agent-worktrees — plan

## Architecture

A new **`src/worktree/WorktreeManager.ts`** owns the git mechanics; everything
else just resolves a cwd through it. Keep the pure decisions (path + branch
resolution, git-arg construction) separable from the side-effecting git calls so
they unit-test without a real repo (mirrors `src/resume/` from spec 209).

```
WorktreeManager (new)  — pure resolvers separated from side-effecting git calls
  ├─ resolveBase(settings): string                 # XDG default or settings.worktree.base
  ├─ pathFor(wsHash, agent): string                # <base>/<wsHash>/<agent>
  ├─ branchFor(agent, settings, agentDef): string  # per-agent > global template({agent}) > tachyon/<agent>;
  │                                                 #   git check-ref-format; reject template w/o {agent}
  ├─ ensure(agent, branch, fromRef): WorktreeRecord # LOCKED: prune → validate-reuse OR create per the
  │     # branch-state matrix (absent→add -b [owned]; exists→attach [not owned]; checked-out-elsewhere→fail).
  │     # Returns {cwd, branch, tachyonCreatedBranch, baseRef, createdAt}.
  ├─ validateReuse(cwd, branch): ok|reason          # git common-dir == this repo AND on expected branch
  ├─ status(cwd, baseRef): {dirty, branch, aheadOfBase, unpushed, detached}  # full cleanup signal
  ├─ canRemove(agent): ok|blocked(descendants)      # guard: no live descendant sessions
  └─ remove(rec, deleteBranch): void                # git worktree remove --force; branch -D ONLY if owned & confirmed
```
A per-agent **lock** serializes ensure/restart/setup/remove. `WorktreeRecord` is
**persisted** (extend `SessionLedger` or a sibling store) so cleanup and C2 read
the real path/branch/ownership, never recompute from drifted config.

Wiring:
- **config/loadConfig.ts** — parse `agents.<n>.worktree` (bool), `.branch` (string),
  `.worktreeSetup` (string|string[]); `settings.worktree.{base,branch}`. Validate
  branch chars; `worktreeSetup` normalized to string[].
- **Workspace** — owns a `WorktreeManager`. On spawn it resolves the cwd:
  top-level + `worktree` → `ensure(...)` then `worktreeSetup` (only on create;
  sequential one-shot exec in the worktree with `TACHYON_WORKSPACE_ROOT` +
  `TACHYON_WORKTREE_ROOT` in env; awaited by the async spawn, NOT the UI thread;
  timeout + cancel; non-fatal); sub-agent → parent's cwd; non-usable-git → root +
  notice. Persists the `WorktreeRecord`. Passes `cwd` to `AgentManager.spawn`.
- **AgentManager** — already threads `cwd` into `newSession`; add a `cwdResolver`
  seam (or pass resolved cwd in opts) so spawn/restart/sub-agent all funnel through
  Workspace's resolution. Lineage already maps child→parent; reuse it for cwd
  inheritance.
- **Studio (AgentForm)** — add the `worktree` toggle (Agent + Terminal tabs) +
  `branch` + `worktreeSetup` fields; `studioSubmit` persists them to yml.
- **Sidebar** — branch badge on worktree agents (`⎇ <branch>`); the kill/dismiss
  command calls `canRemove()` (block on live descendants) then `status()` and shows
  the full modal (path + dirty + ahead/unpushed + ownership). `branch -D` only for
  a Tachyon-created branch; human branch kept unless a second explicit confirm.
- **Bridge (MCP)** — `spawn_agent` schema gains `worktree?: boolean` (top-level
  only; ignored+warned for `parent` spawns).
- **MCP/UI for C2** — expose `worktreePathFor(agent)` so the future diff-review can
  read it. (No UI here.)

## Sequencing

1. Config schema + pure resolvers (path/branch/arg-construction) + unit tests.
2. WorktreeManager git side (ensure/status/remove) + a real-git integration test
   in a tmp repo.
3. Workspace spawn-cwd resolution (top-level worktree / sub-agent inherit / root
   fallback / non-git) + worktreeSetup runner.
4. Restart + reuse path; branch/worktree reuse on a kept prior run.
5. Kill/dismiss confirmation (uncommitted-aware) → remove.
6. Studio fields + Sidebar branch badge + nls (en + pt-br).
7. MCP `spawn_agent.worktree` + docs (README settings + scaffold hint).

## Risks / edges

- **In-worktree concurrency** (parent + children share it) — accepted (Decision 2);
  same as today's shared cwd, and orchestration is usually sequential.
- **`git worktree add` from a dirty/detached HEAD** — add still works (separate
  checkout); branch off `HEAD`. Document.
- **Branch already exists** (kept prior run) → `git worktree add <path> <branch>`
  (no `-b`) to attach the existing branch.
- **worktreeSetup failure** — surface, non-fatal (spawn anyway) unless we later add
  a `requireSetup` flag (not now).
- **Stale worktree dir without git metadata** (user `rm`'d it) → `git worktree
  prune` before ensure; recreate.

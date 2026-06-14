# 210 — tachyon-agent-worktrees

_Created 2026-06-13._

**Status:** shipped (v0.13.0)

**UI impact:** interaction
<!-- Studio toggle, a branch badge on worktree agents in the tree, and a
kill/dismiss confirmation that warns about uncommitted work. Verified by driving
a real git repo: spawn an agent in a worktree, confirm the session cwd is the
worktree on its own branch, sub-agents share it, cleanup uses git worktree remove. -->

## Intent

**C1 — isolate each parallel agent in its own git worktree+branch, opt-in.**

Today every Tachyon agent runs in the same workspace cwd, so parallel agents
clobber each other's files — the one thing that breaks real parallel work. The
2026 landscape is unanimous (Claude Squad, Conductor, Crystal, Emdash, Composio,
Bernstein): **a worktree per unit of work** is the table-stake. A worktree is a
git mechanism, so this is **runtime- and kind-agnostic** — it only changes the
cwd the tmux session is born in (an isolated checkout on its own branch). The
agent's diff becomes one coherent, reviewable, shippable branch (the C2 diff-review
spec consumes this).

This spec resolves **everything worktree-related** — no follow-ups.

## Decisions (settled in design discussion, 2026-06-13)

1. **Opt-in per agent, Studio toggle** like `autostart`. Mechanism is git, so it
   works for any runtime (claude/codex/gemini/qwen/…) and any `kind`. Off by
   default; for `kind: terminal` it is available but naturally left off (a dev
   server wants the main tree — branch/port semantics differ).
2. **Sub-agents inherit the parent's worktree.** A worktree = one unit of work =
   one branch = one PR. Agents spawned with `parent` are helpers on the SAME
   task → they run in the parent's worktree (same branch, one diff). `worktree:
   true` on a `parent`-spawn is a **no-op + warning** ("children share the parent's
   worktree; spawn top-level to isolate"). A child always inherits the parent's
   cwd, whatever it is (worktree or workspace root). **Descendant-lifecycle guard
   (review fix):** removing a parent's worktree is blocked while any descendant
   session is alive — the confirmation must first stop/remove the whole subtree,
   or be declined; never yank a running child's cwd. Concurrent writes within the
   shared worktree are an **accepted, documented trade-off** (identical to today's
   shared cwd; parent→child orchestration is normally sequential) — worktrees
   isolate the squad from OTHER top-level agents, which is the win.
3. **Cleanup is human-decided on kill/dismiss, and never destroys work it can't
   prove is disposable (review fix).** The confirmation shows: the worktree path,
   dirty state (staged/unstaged/untracked/conflicts), **commits ahead of the base
   ref / unpushed**, and **whether Tachyon created the branch**. Rules:
   - **Only a Tachyon-created branch may be `git branch -D`'d.** A pre-existing
     human branch (attached via per-agent `branch:`) is NEVER force-deleted — the
     worktree is removed but the branch is kept, unless the human *explicitly*
     confirms branch deletion in a second, spelled-out step.
   - Accept (Tachyon-owned, clean-or-confirmed) → `git worktree remove --force` +
     `git branch -D <branch>`.
   - Decline → nothing destroyed; the agent transitions to stopped, its sidebar
     entry + worktree + branch remain (an explicit "Remove worktree" action exists
     for later).
   - Never `rm -rf` / `mv` (git bookkeeping + the governance-gate forbid it).
4. **Branch name** is configurable per-agent AND globally; agent overrides global;
   default `tachyon/<agent>`. Validated with `git check-ref-format --branch` (not a
   hand-rolled charset). The global template **must** contain `{agent}` (else every
   agent collides on one branch) — reject a template without it. Tachyon records
   per worktree whether IT created the branch (ownership — drives Decision 3).
5. **Location: central, keyed by wsHash, configurable.** Path =
   `<worktreeBase>/<wsHash>/<agent>/`. External (not nested in the repo) is the git
   best-practice and avoids the real hazard for Tachyon: the open workspace's
   watchers + every agent's tools (rg/tsc/bundler/test-runner) traversing N full
   checkouts nested under the repo → watch-storms + duplicate indexing. Central-by-
   wsHash also keeps the parent dir clutter-free. `worktreeBase` is global-only
   (no per-agent need); default `~/.cache/tachyon/worktrees` (XDG-aware).
6. **`worktreeSetup`** — optional per-agent command(s) run in the fresh worktree
   before the agent starts. A fresh worktree is a clean checkout: no `node_modules`,
   no untracked/`.env` files. **Process semantics (review fix):** runs **only on
   create**, not on reuse/restart (unless `worktreeSetup.always: true`); commands
   run **sequentially, stop on first failure**; output is surfaced (a transient
   "setup" pane), with a timeout + cancellation; "blocking" means the **async spawn
   awaits** setup — it must NEVER block the VS Code extension host. Failure is
   surfaced and **non-fatal** (the agent still spawns). Setup runs with
   `TACHYON_WORKSPACE_ROOT` and `TACHYON_WORKTREE_ROOT` injected (the central path
   is NOT a relative hop from the repo — see the corrected example below). In scope.

## Config surface

```yaml
settings:
  worktree:
    base: ~/.cache/tachyon/worktrees   # global location root (default shown)
    branch: "tachyon/{agent}"          # global branch template; {agent} placeholder

agents:
  reviewer:
    cmd: claude
    worktree: true                     # opt-in (default false)
    branch: feature/auth-redesign      # per-agent literal branch (overrides global template)
    worktreeSetup:                     # run ONCE on create, sequentially, before the agent
      - pnpm install
      - cp "$TACHYON_WORKSPACE_ROOT/.env.local" .env.local   # central path ≠ ../.. — use the env var
```

Resolution: branch = per-agent `branch` ?? global `branch` template with `{agent}`
?? `tachyon/<agent>`. base = global `settings.worktree.base` ?? XDG default. (Agent
names are already filesystem-safe — the schema validates `^[a-zA-Z][a-zA-Z0-9_-]*$`,
so no `/`, `..`, spaces, or reserved chars reach a path. No extra sanitization
needed — a deliberate non-change vs. the review's suggestion.)

## Behavior

- **Spawn (top-level, `worktree:true`):** under a per-agent **lock** (serializes
  concurrent spawn/restart/setup/remove), `git worktree prune` (clear stale
  metadata), then resolve `<base>/<wsHash>/<agent>/`:
  - **Reuse only if validated (review fix):** the path is a git worktree whose
    common dir == this repo's, AND it's on the expected branch. Mismatch (e.g.
    branch config changed, or the agent switched/detached the branch inside) →
    surface + prompt, don't silently reuse stale state.
  - **Create — branch-state matrix (review fix):** branch absent →
    `git worktree add -b <branch> <path> HEAD` (record **Tachyon-created**); branch
    exists, not checked out → `git worktree add <path> <branch>` (attach, **not**
    Tachyon-created); branch checked out elsewhere (another worktree / main tree) →
    fail with a clear message (don't clobber).
  - Run `worktreeSetup` (only on create; sequential; awaited by the async spawn,
    not the UI thread; failure non-fatal). Start the tmux session `cwd = <path>`.
  - **Persist** `{worktreePath, branch, tachyonCreatedBranch, baseRef, createdAt}`
    in session/ledger state — the source of truth for cleanup + for C2 (C2 reads
    it, never recomputes from current config, which may have drifted).
- **Not usable as a git worktree → fall back to workspace root + notice (review
  fix):** git binary absent, not a git repo, **unborn repo (no commits / no HEAD)**,
  bare repo, or `git worktree add` failing for any reason. Never block the agent.
- **Sub-agent spawn (`parent` set):** session `cwd = parent's cwd` (its worktree if
  any, else root). Ignore `worktree:true` with a warning.
- **Restart:** reuse the existing (validated) worktree; do NOT re-run setup.
- **Kill / dismiss:** if in a worktree, show the Decision-3 confirmation (path +
  dirty + commits-ahead/unpushed + branch ownership); blocked while descendants
  are alive (must stop the subtree first).
- **Tree:** a worktree agent shows a branch badge (e.g. `⎇ tachyon/reviewer`).
- **MCP:** `spawn_agent` gains optional `worktree: boolean` (top-level only).

## Non-goals

- **Diff-review UI (C2)** — separate spec; C1 only exposes the worktree path/branch
  for it to consume.
- **Nested per-sub-agent worktrees** — rejected (Decision 2).
- **Autonomous merge / PR creation** — human-at-gate stays; out of scope.
- **Per-agent location override** — global-only by decision.

## Acceptance

- An agent with `worktree:true` runs in `<base>/<wsHash>/<agent>/` on its branch;
  edits there do not touch the main tree.
- A sub-agent of it shares the same worktree/branch (one diff).
- Branch name resolves: per-agent > global template > `tachyon/<agent>`.
- Kill prompts with path + dirty + commits-ahead/unpushed + branch ownership;
  accept removes the worktree, and `branch -D` ONLY a Tachyon-created branch; a
  human branch is kept unless a second explicit confirmation; decline keeps all.
- A pre-existing human branch is **never** auto-deleted (verified by test).
- Removing a parent worktree is blocked while a descendant session is alive.
- Reuse is rejected when the path's git common-dir ≠ this repo or the branch
  differs from expected (no silent stale reuse).
- `worktreeSetup` runs once on create, sequentially, with
  `TACHYON_WORKSPACE_ROOT`/`TACHYON_WORKTREE_ROOT` set; failure surfaced, non-fatal;
  never blocks the extension host.
- Branch names validated via `git check-ref-format`; a global template without
  `{agent}` is rejected.
- Non-usable-git cases (absent binary, unborn/bare repo, add failure) fall back to
  root with a notice; no crash.
- Worktree metadata (`worktreePath`/`branch`/`tachyonCreatedBranch`/`baseRef`) is
  persisted and is the cleanup + C2 source of truth.
- Pure resolvers (path, branch, git-arg construction, sub-agent cwd inheritance,
  ownership decision) are unit-tested; a real-git integration test covers
  add/reuse-validation/branch-exists-elsewhere/dirty/ahead/remove.

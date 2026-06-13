# 210 — tachyon-agent-worktrees — notes

## Origin
Came out of the 2026-06-13 competitor-landscape research (recorded in Agent0
memory `project_tachyon_overclock_re_roadmap`). Labelled **C1** there — the
highest-leverage item, because "all [competitors] use git worktrees" and Tachyon
runs every agent in the same cwd. C2 (diff-review) and C3 (verify-gate, which
merges with the parked Overclock "validated handoff" item) are separate.

## Why this matters now
VS Code v1.109 (Feb 2026) shipped native multi-agent (Agents window, parallel
runs, handoff, sandboxing) — chat-first, BYO-API-key, cloud-leaning. Tachyon's
moat is the opposite: the REAL CLIs (full TUI, your subscription) as persistent
tmux terminals + the MCP Bridge. Worktree isolation deepens that moat (safe
parallel fleets of real CLIs) rather than chasing native's lane.

## Design decisions (discussion log, 2026-06-13)
- **Mechanism is git → runtime/kind-agnostic.** Confirmed: the toggle only changes
  the session's starting cwd. Off-by-default; `kind: terminal` available but
  usually off (dev server wants the main tree).
- **Sub-agents inherit the parent's worktree.** Principle: worktree = one unit of
  work = one branch = one PR; lineage = same task. Per-sub-agent worktrees rejected
  (tree-of-branches, parent can't see child's uncommitted work, breaks one-PR).
  Want isolation? → spawn top-level, not as a child.
- **Cleanup human-decided** (Decision 3 in spec): warn on uncommitted; accept
  destroys (worktree + branch) via `git worktree remove --force` + `branch -D`;
  decline keeps everything. Never `rm -rf`.
- **Branch** per-agent + global template, agent wins, default `tachyon/<agent>`.
- **Location central by wsHash, configurable** — the researched choice.

## Location research (why external/central, not nested-in-repo)
- Git best practice: worktrees go OUTSIDE the working tree as siblings —
  *"nesting leads to confusing .git resolution and breaks tools that walk up looking
  for the repo root."* ([gitworktree.org](https://www.gitworktree.org/guides/best-practices))
- Claude Code defaults to `.claude/worktrees/` INSIDE the repo (configurable
  `worktreeDir`), but has a known bug that `.claude/` isn't copied to the worktree
  ([anthropics/claude-code#28041](https://github.com/anthropics/claude-code/issues/28041)).
- **The nested hazard is worse for Tachyon than for single-session Claude Code:**
  the workspace is open in VS Code with watchers, and every one of N agents runs
  tools (rg/tsc/bundler/test-runner) that would traverse N full nested checkouts →
  watch-storms + duplicate indexing. So external wins decisively here.
- Central-by-wsHash (`<base>/<wsHash>/<agent>/`) avoids both the nested hazard AND
  the parent-dir clutter of plain siblings. Tachyon already namespaces by wsHash.
- Cleanup MUST use `git worktree remove` (not `rm -rf`/`mv`) to keep git's
  bidirectional bookkeeping intact (and it aligns with the governance-gate).

## Resolved open questions
- **Worktree setup** (fresh checkout has no node_modules/.env/untracked): solved by
  the in-scope `worktreeSetup` per-agent command(s), run blocking before the agent.
- **Branch base ref**: default `HEAD` of the main repo at spawn time.
- **Reuse**: a kept worktree/branch (declined cleanup) is reused on restart, not
  recreated; attach existing branch (no `-b`).

## Scope guard
Everything worktree-related lands here (no follow-ups) per the user's instruction.
C2/C3 are deliberately separate specs; this only exposes the worktree path/branch
for C2 to consume.

## Review — codex GPT-5.5 (effort xhigh), 2026-06-13 — INCORPORATED
Spawned as a Tachyon sub-agent (dogfood) to review the draft; verdict **revise**.
All findings triaged with the maintainer; accepted fixes folded into spec/plan/tasks:
- **Cleanup safety (top finding):** warn/show not just dirty but **commits ahead of
  base / unpushed**; `branch -D` ONLY a **Tachyon-created** branch (ownership) — a
  pre-existing human branch is never force-deleted (worktree removed, branch kept
  unless a 2nd explicit confirm).
- **Reuse validation:** require the path's git common-dir == this repo AND on the
  expected branch before reusing; no silent stale reuse.
- **Branch-state matrix on create:** absent→`-b`(owned) / exists→attach(not owned) /
  checked-out-elsewhere→fail.
- **Descendant-lifecycle guard:** block parent-worktree removal while a child session
  is alive (stop the subtree first).
- **worktreeSetup semantics:** run once on create (not reuse), sequential/stop-on-
  failure, awaited by the async spawn (never the UI thread), timeout+cancel, output
  surfaced; inject `TACHYON_WORKSPACE_ROOT`/`TACHYON_WORKTREE_ROOT` (the central path
  is NOT `../..`); the old `cp ../../.env.local` example was wrong — fixed.
- **Branch validation** via `git check-ref-format`; global template must contain
  `{agent}`.
- **Persist** `WorktreeRecord` (path/branch/ownership/baseRef) — cleanup + C2 read it,
  never recompute from drifted config.
- **Broader non-git fallback:** absent git binary, unborn/bare repo, add failure.
- **Per-agent lock** for concurrent spawn/restart/setup/remove.

**Pushed back (NOT changed):** the review's "sanitize agent names for the filesystem"
— agent names are already validated `^[a-zA-Z][a-zA-Z0-9_-]*$` by the config schema,
so they're inherently path-safe (the reviewer lacked that project context). And the
in-worktree concurrent-write concern stays an **accepted, documented trade-off**
(identical to today's shared cwd; orchestration is sequential) rather than a blocker.

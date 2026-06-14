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

## Implementation progress
- **Tasks 1-2 DONE (commit `35d6713`, NOT released — inert until wired).**
  - Config: agent `worktree`/`branch`/`worktreeSetup` (+ `validateBranchLiteral`
    pre-filter) and `settings.worktree.{base,branch}` ({agent} required). JSON schema
    updated. 16 config tests.
  - `src/worktree/WorktreeManager.ts` — PURE module only so far (mirrors src/resume/):
    `resolveBase` (XDG), `pathFor`, `branchFor`, `actionForBranchState` (create/attach/
    fail matrix), `validateReuse`, `gitArgs` builders. `WorktreeRecord` type defined.
    15 unit tests, no real git.
  - **Refinement vs tasks.md wording:** `git check-ref-format` is NOT inside `branchFor`
    (kept pure); it runs in `ensure()` (Task 3, side-effecting) on the resolved branch.
    `branchFor` does the pure resolution + the `{agent}`-template reject. Matches the
    plan's "pure resolvers separated from side-effecting git calls."
- **Task 3 DONE (commit `f25804d`):** WorktreeManager git side — GitExec seam,
  per-agent lock, isUsableRepo (ok/no-git/not-repo/unborn/bare), ensure (prune→
  validated-reuse OR create-matrix; check-ref-format), status, remove (branch -D only
  if Tachyon-owned), WorktreeUnavailableError, pathForAgent. 8 real-git integration
  tests. **`canRemove` deferred to Task 5** (the kill flow) — it needs AgentManager
  lineage for the live-descendant guard, so it belongs with the kill UI, not the git
  layer.
- **Task 3b DONE (commit `babedc3`):** `SessionRecord.worktree?` persisted +
  parsed by normalize(). Cleanup + C2 read it.
- **CORE COMPLETE (Tasks 1-3b): config + pure resolvers + git side + persistence,
  ~39 new tests, all inert (no spawn wiring) → zero behavior change, safe on main.**
- **Remaining = WIRING + UI: Task 4 (spawn cwd resolution + setup runner — the hot
  path), 5 (kill/dismiss flow + canRemove descendant guard), 6 (Studio), 7 (Sidebar
  badge), 8 (MCP `spawn_agent.worktree`), 9 (docs), 10 (live smoke).** Then codex
  review + ship. No marketplace release until Task 4 makes spawn coherent.
- **Pacing note:** Task 4 touches the spawn hot-path. This session already hit a
  spawn-path regression (the `--session-id`+`--resume` crash, v0.12.8) from layering
  onto spawn — so Task 4 warrants care + a live EDH smoke. Good fresh-context
  continuation point.
- **ALL TASKS DONE (1-10).** Tasks 4-10 implemented under the `/goal` directive:
  spawn cwd resolution + setup runner (4), kill/dismiss cleanup + descendant guard (5),
  Studio fields (6), Sidebar ⎇ badge + Remove Worktree action (7), MCP spawn_agent.worktree
  (8), README + Init docs (9), headless E2E smoke (10, real git + real setup).
- **codex dueto, 2 review rounds → 11 findings, all fixed + regression-tested:**
  round 1 (`fdbfca4`): 1 BLOCKER (liveDescendants ignored ledger lineage → declared
  child's parent worktree could be yanked) + 6 major (declared-non-adapter worktree not
  recorded; restart dropped the record; clearWorktree left stale cwd; reuse returned a
  drifted prior; lock-key mismatch + racy setup pre-check; cleanup removed a running cwd).
  round 2 (`52dbd09`): 4 major (swallowed kill failure; rehydrate lost worktree:true;
  declared-non-adapter sub-agent parent not recorded; setup outside the lock).
  round 3: **SHIP** — zero findings.
- **Verify:** `npm run typecheck && npm test` → 350 tests green.

## Closure
**Closure:** shipped as **v0.13.0** (commit pending after this doc), spec 210 fully
implemented + validated (codex dueto SHIP, 350 tests, real-git integration + E2E).
Task 10's interactive EDH portion (clicking through Studio/kill modals in the live
Extension Development Host) is handed to the maintainer as a smoke recipe — the
mechanism itself is proven headlessly E2E. No open follow-ups; C2 (diff-review) and
C3 (verify-gate) remain deliberately separate specs and consume `worktreePathFor`.

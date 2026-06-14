# 214 — tachyon-verify-gate

_Created 2026-06-14._

**Status:** draft — design under review (not yet greenlit to implement)

**UI impact:** interaction
<!-- A "Verify" action + a pass/fail/stale badge on worktree agents. Verified by
driving a real worktree: run the gate, see it pass; commit more, see it go stale;
break a test, see it fail. -->

## Intent

**C3 — a worktree's work is "shippable" only after a declared check (lint/test/build) passes.**

C1 (210) isolates an agent's work on a branch; C2 (213) lets you review it. C3 adds the
**verification gate**: run a declared command/runbook **inside the worktree** and surface a
pass/fail signal, so "ready to merge" is *evidenced*, not assumed. This is the **validated
handoff / done-gate** (Bernstein's pre-merge "janitor" + Agent0 `/squad`'s verified done-gate +
Overclock's handoff registry — one idea from several directions). It **reuses Tachyon's
existing `commands`/`runbooks`** as the gate — no new executor concept.

**Human stays at the gate.** C3 produces a *signal*; it never auto-merges, auto-PRs, or blocks
you. It makes the cleanup/review flow *informed* (e.g. "not verified — remove anyway?").

## Proposed design (the decisions to confirm)

1. **Declaration — per-agent `verify:` naming an existing command or runbook**, e.g.
   `verify: ship` (a runbook) or `verify: test` (a command). Optional global default
   `settings.worktree.verify`. Reuses the curated, exit-code-gated `commands`/`runbooks` you
   already declare — the gate is "does `<verify>` exit 0 in the worktree?". **(Decision A.)**
2. **Run IN the worktree cwd.** The CommandRunner/RunbookRunner currently run in
   `workspaceRoot`; C3 threads a `cwd` override so the gate runs against the agent's branch.
   Exit 0 = pass, non-zero = fail (runbooks already gate per step). **(Decision B — reuse the
   runners with a cwd override vs a dedicated verify runner.)**
3. **Surface as a badge + persisted result, keyed to the verified commit.** The worktree agent
   shows `✓ verified` / `✗ failing` / `⊘ not verified`. The result is stored with the HEAD
   commit it ran against → it goes **stale** (`⊘`) when the agent commits/changes after. **(Decision
   C — show stale-vs-failing distinctly?)**
4. **Advisory, never blocking.** The kill/dismiss + Review surfaces the verify state but never
   prevents anything — merge stays human + plain git. **(Decision D — confirm advisory-only.)**
5. **Trigger — manual v1.** A "Verify" action runs it on demand; auto-run-on-idle/stop is a
   later, opt-in enhancement (don't fire long test suites unprompted). **(Decision E.)**
6. **MCP — reuse + expose, thin tool only if needed.** `list_agents` exposes the verify state
   (the handoff signal a parent reads); a worktree agent runs its gate via the existing
   `run_command`/`run_runbook` (now cwd-aware for worktrees). A dedicated `verify_agent` tool
   only if the handoff use case proves it. **(Decision F.)**

## Behavior (proposed)

- **Verify** (action on a worktree agent, or `settings`/per-agent declared) → run the named
  command/runbook in the worktree cwd → record `{passed, atCommit, ranAt}` → badge updates.
- **Stale** when the worktree's HEAD/working tree moved past `atCommit` → `⊘ not verified`.
- **Cleanup/Review** show the verify state (`✓/✗/⊘`) — informative, not gating.
- No verify declared → no gate, no badge (feature is opt-in, like worktree itself).

## Non-goals

- Auto-merge / auto-PR / blocking the human — out of scope (human-at-gate; C3 is a signal).
- A new executor — reuse `commands`/`runbooks`.
- Auto-running the gate on every change — manual v1 (auto is a later opt-in).
- CI integration / remote checks — local declared command only.

## Open questions (for the design review)

- **OQ1:** per-agent `verify:` vs global `settings.worktree.verify` vs both? (proposed: both,
  per-agent wins.)
- **OQ2:** reuse CommandRunner/RunbookRunner with a `cwd` override (less code, but threads a new
  param through them) vs a small dedicated worktree-verify runner (isolated, but duplicates the
  exit-code/pane plumbing)? (proposed: reuse + cwd override.)
- **OQ3:** does verify auto-stale on ANY working-tree change, or only on a new commit? (proposed:
  stale on HEAD move OR dirty since ranAt.)
- **OQ4:** is the "validated handoff" (an agent signals done+green to its parent) in scope for v1,
  or just the human-facing badge first? (proposed: human badge v1; handoff = a thin follow.)

## Acceptance (provisional — finalized after the design review)

- A worktree agent with `verify: <cmd/runbook>` → Verify runs it in the worktree → badge shows
  pass/fail; committing more makes it stale; a failing check shows `✗`.
- Reuses existing commands/runbooks; runs in the worktree cwd (not the workspace root).
- Advisory only — never blocks kill/merge. Opt-in (no verify declared → nothing changes).
- Verify state is exposed to agents via `list_agents` (the handoff signal).

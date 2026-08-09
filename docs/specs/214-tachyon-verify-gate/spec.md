# 214 — tachyon-verify-gate

_Created 2026-06-14._

**Status:** shipped — v0.14.0 (2026-06-14)

**Closure:** Implemented across d0d5933 (backend), f7048bf (UI/MCP/Studio), 75950ef +
c5c653b (codex review rounds 1–2), 9af4fa2 (docs). Tasks 1–9 done; **403 unit tests** green
(incl. a real-git + real-tmux live smoke of the verify execution path —
`verifyGate.integration.test.ts`), typecheck + build clean, 3 adversarial codex-dueto rounds
(12 findings, all resolved → effectively SHIP). Shipped as **v0.14.0** (b5d90eb). The only
acceptance not auto-verified is the purely-visual VS Code badge/Studio rendering (recipe in
notes.md § Live smoke, for a manual glance after a window reload); the MCP transport is E2E in
bridge.test and the execution path is real-infra smoke-tested.

**Verify:** `npm run typecheck && npm test`

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

## Confirmed design (decisions locked 2026-06-14)

1. **Declaration — per-agent `verify:` naming an existing command or runbook**, e.g.
   `verify: ship` (a runbook) or `verify: test` (a command). Optional global default
   `settings.worktree.verify`. The gate is "does `<verify>` exit 0 in the worktree?".
2. **Configured in the Agent Studio, STACK-SUGGESTED, human has the final word.** The Studio's
   worktree section gains a `verify` field. Tachyon **suggests** candidates from the detected
   stack — for Node, the real `package.json` scripts (`npm test`, `npm run lint`, `npm run
   build`); cargo/go/pytest/etc. for other stacks — offered as pick-from chips. **The human
   chooses or overrides; the suggestion is never imposed.** (Mirrors `Tachyon: Init`'s stack
   detection.) The choice persists to `tachyon.yml` (`verify:` / a referenced command/runbook).
3. **Run IN the worktree cwd.** CommandRunner/RunbookRunner run in `workspaceRoot` today; C3
   threads a `cwd` override so the gate runs against the agent's branch. Exit 0 = pass.
4. **Surface as a badge + persisted result, keyed to the verified commit.** `✓ verified` /
   `✗ failing` / `⊘ not verified`; stored with the HEAD commit it ran against → **stale** (`⊘`)
   when the agent commits/changes after.
5. **Advisory, never blocking.** Kill/dismiss + Review surface the verify state; merge stays
   human + plain git. Opt-in (no `verify` declared → no gate, no badge).
6. **Trigger — manual v1.** A "Verify" action (and MCP) runs it on demand; auto-run-on-idle is
   a later opt-in (the human sets the *what* in Studio; the *when* stays manual for v1).
7. **Scope v1 = badge + validated handoff (MCP).** `list_agents` exposes the verify state
   (`{passed, atCommit, ranAt, stale}`) so an orchestrating parent reads "child finished AND
   passed"; a worktree agent runs its gate via `run_command`/`run_runbook` (now cwd-aware), and
   a thin `verify_agent` MCP tool runs the declared gate + returns the result. The full
   done-gate/validated-handoff, not just a human badge.

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

## Resolved questions (2026-06-14)

- **OQ1 → both**, per-agent `verify:` wins over global `settings.worktree.verify`.
- **OQ2 → reuse** CommandRunner/RunbookRunner with a `cwd` override (no duplicate executor).
- **OQ3 → stale on HEAD move OR working-tree dirty since `ranAt`** (a re-verify is one click).
- **OQ4 → validated handoff IS in v1** (badge + MCP), per the product call.
- **Studio (new):** verify is chosen in the Agent Studio with **stack-derived suggestions** the
  human can override — never imposed.

## Acceptance

- A worktree agent with `verify: <cmd/runbook>` → Verify (UI action or MCP) runs it in the
  worktree cwd → badge shows `✓/✗`; committing/changing makes it `⊘ stale`; a failing check `✗`.
- Reuses existing commands/runbooks; runs in the worktree cwd, never the workspace root.
- Advisory only — never blocks kill/merge. Opt-in (no `verify` → nothing changes, no badge).
- **Studio** offers stack-suggested verify candidates (Node package.json scripts, cargo/go/
  pytest/…); the human picks or types their own; the choice persists to tachyon.yml.
- **Handoff:** `list_agents` exposes `{passed, atCommit, ranAt, stale}`; a `verify_agent` MCP
  tool runs the declared gate and returns the result — a parent can gate on "child + green".
- Pure parts (stack→suggestion mapping, stale computation, verify-state shape) unit-tested; the
  worktree-cwd run is integration/smoke-tested.

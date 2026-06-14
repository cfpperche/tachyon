# 214 — tachyon-verify-gate — notes

## Origin
Roadmap **C3** (Agent0 memory `project_tachyon_overclock_re_roadmap`) — the last worktree-family
item. Merges three convergent ideas: Bernstein's pre-merge "janitor" gate, Agent0 `/squad`'s
verified done-gate, and Overclock's handoff registry (F2). C1 (210) isolate + C2 (213) review →
C3 verify closes the loop with *evidence* that the branch is shippable.

## Confirmed product decisions (2026-06-14, with the maintainer)
- **Studio-driven, stack-suggested, human's final word.** The verify command is chosen in the
  Agent Studio; Tachyon suggests from the detected stack (Node package.json scripts, cargo/go/
  pytest/…) but never imposes — the human picks or types their own. (Mirrors `Tachyon: Init`.)
- **Scope v1 = badge + validated handoff (MCP), together** — not just a human badge. list_agents
  exposes the verify state; a `verify_agent` tool runs the gate; a parent can gate on child+green.
- **Trigger manual v1** — the human sets *what* runs (Studio); the *when* stays a manual Verify
  action/MCP call for v1 (auto-on-idle is a later opt-in; don't fire test suites unprompted).
- **Advisory, never blocking** — merge stays human + plain git; verify is a signal.
- **Reuse commands/runbooks** with a cwd override — no new executor.

## Status
**IMPLEMENTED + reviewed** (2026-06-14). Tasks 1–8 done; Task 9 (live EDH smoke) pending.

## Implementation decisions (as built)
- **verify resolution = command > runbook > inline** (matches config docs/schema). A command/
  inline name → a single step; a runbook name → its steps. Run via RunbookRunner.runSteps
  under the internal label `_verify-<agent>` — the leading `_` is NAME_RE-impossible (so it can
  never collide with a user-declared runbook) AND tmux-safe (no `:`). Reuses the runbook
  executor (cwd override) — no new executor. A referenced command's cwd/env flow through too.
- **Staleness = HEAD moved past atCommit OR working tree dirty now.** A verify run on a dirty
  tree reads stale immediately — intentional: verify proves a *commit* shippable, not a dirty
  WIP. Rejected a worktree-fingerprint ("dirty since ranAt") as over-engineering for v1
  (matches the "match rigor to reversibility" rule). A re-verify is one click.
- **Studio**: stack-suggested chips (Workspace.verifyCandidates = detectStack + package.json
  scripts + declared command/runbook names); the human picks or types their own — final word.
- **Handoff**: list_agents exposes {command,passed,atCommit,ranAt,stale}; verify_agent runs the
  gate. verify_agent recomputes staleness after the run (never hardcodes false; defaults to
  stale when verifyInfo can't be resolved). verifyInfo treats a *changed* verify command as
  not-verified, so swapping `verify:` never shows the old result as fresh.

## codex dueto (gpt-5.5 xhigh, read-only, in ~/tachyon)
- **Round 1** — NO-SHIP, 8 findings (3 BLOCKER: `:` in tmux label, verify_agent hardcoded
  stale:false, stale ignored a changed command; 3 MAJOR: reuse dropped verify, runbook-wins
  precedence, step dropped command cwd/env; 1 MINOR git-call cost; 1 design note). All fixed
  (75950ef).
- **Round 2** — NO-SHIP, 4 findings (verify_agent stale fallback → true; `verify-` could
  collide with a user runbook → `_verify-`; badge skipped on dead/crashed agents; tests on the
  old label). All fixed (c5c653b).
- **Round 3** — all functional fixes confirmed resolved; only 2 stale PROSE label references
  left (fixed). No remaining correctness/race/crash issue. Effectively SHIP.

## Live smoke (Task 9 — pending a reload to 0.14.0)
The connected MCP bridge is the OLD build until the window reloads, so verify_agent isn't
reachable yet. Once on 0.14.0 (reload the window — the marketplace auto-updates the extension):
1. Add a worktree agent with a verify gate, e.g.
   `feat: { cmd: claude, worktree: true, verify: test }` and a `commands: { test: { cmd: npm test } }`
   (or inline `verify: "npm test"`). Start it.
2. Sidebar: it shows `⊘ not verified`. Click the inline **Verify** (✓) action → it runs `npm test`
   in the worktree → badge flips to `✓ verified` (or `✗ failing`).
3. Commit/change in the worktree → badge goes `⊘` (stale, keyed to the verified commit).
4. Handoff: from a parent agent call `verify_agent name=feat` → `{passed, atCommit, stale}`;
   `list_agents` shows the same verify block. Studio: edit the agent → the verify field offers
   stack-suggested chips (npm test / npm run build / …) + declared command/runbook names.

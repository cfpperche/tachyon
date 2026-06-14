# 214 — tachyon-verify-gate — plan

## Architecture

Reuses the existing curated executors (`commands`/`runbooks`) as the gate; adds a cwd
override so they run in the worktree, a persisted verify-state, a Studio field with
stack-derived suggestions, a badge, and the MCP handoff surface.

```
config/loadConfig.ts — agent `verify: <command|runbook name>`; `settings.worktree.verify`.
src/worktree/verify.ts (new, pure)
  ├─ suggestVerify(stack, pkgScripts): string[]   # stack→candidate commands (Node reads package.json scripts)
  ├─ verifyStale(rec, headRef, dirty): boolean     # stale when HEAD moved past atCommit OR dirty since ranAt
  └─ VerifyState type { passed, atCommit, ranAt, stale }
CommandRunner / RunbookRunner — accept an optional `cwd` (default workspaceRoot) so the gate
  runs in the worktree; exit-code result already surfaced.
Workspace — runVerify(agent): resolve the agent's worktree cwd + declared verify name → run the
  command/runbook there → record VerifyState (atCommit = worktree HEAD) in the ledger/worktree store.
SessionLedger/WorktreeRecord — persist the VerifyState (keyed to the agent's worktree).
Sidebar — verify badge on worktree agents (✓/✗/⊘), tooltip with ranAt/atCommit.
webview/AgentForm (Studio) — a `verify` field in the worktree section; stack-suggested chips
  (reuse the Init/cliDetect stack detection + package.json scripts) the human picks/overrides.
bridge/tools.ts — list_agents exposes VerifyState; `verify_agent` runs the gate + returns result.
extension.ts — `tachyon.verifyAgentItem` (action) + palette-hidden.
```

## Sequencing

1. config (`verify` per-agent + global) + pure `verify.ts` (suggestVerify, verifyStale, state) + tests.
2. Runner cwd override (CommandRunner + RunbookRunner) + tests.
3. Workspace.runVerify (run in worktree cwd, record VerifyState) + persist on the record.
4. Sidebar verify badge + Studio verify field with stack-suggested chips.
5. MCP: list_agents VerifyState + `verify_agent` tool.
6. extension verifyAgentItem action + package.json/nls + README.
7. Live smoke + codex dueto.

## Risks / edges
- Long-running verify (test suites) — manual trigger v1; surface a "verifying…" state; never block UI.
- Stale detection must be cheap (HEAD rev-parse + dirty check) — reuse WorktreeManager.status.
- Stack suggestion must degrade (no package.json / unknown stack → no suggestion, human types it).
- A verify naming a runbook with multiple steps → the runbook's own exit-gate is the verdict.
- Non-worktree agents: verify is worktree-scoped (no isolated branch to gate) — feature is off for them.

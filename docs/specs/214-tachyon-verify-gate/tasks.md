# 214 — tachyon-verify-gate — tasks

**Verify:** `npm run typecheck && npm test`

## Implementation

- [x] 1. **Config + pure `src/worktree/verify.ts`**: parse agent `verify: <name>` +
      `settings.worktree.verify` (loadConfig + schema). `verify.ts`: `VerifyState`
      ({command, passed, atCommit, ranAt}); `effectiveVerify` (per-agent > global);
      `suggestVerify(stackLabel, pkgScripts)`; `verifyStale(state, headRef, dirty)`;
      `verifyBadge`; `verifySteps` (runbook name → steps, else single step). Unit-tested, no git.
- [x] 2. **Runner cwd override**: CommandRunner.run(name, cwd?) + RunbookRunner.run(rb, cwd?)
      and a new `runSteps(label, steps, cwd?)` (the verify executor). Unit-tested.
- [x] 3. **Workspace.runVerify(agent)**: resolve the agent's worktree + effective verify →
      run via RunbookRunner.runSteps in the worktree cwd (label `_verify-<agent>`, tmux-safe +
      NAME_RE-impossible so it can't collide with a user runbook) → record
      `VerifyState` (atCommit snapshotted via WorktreeManager.headState). verifySteps unit-tested.
- [x] 3b. **Persist `VerifyState`** on the WorktreeRecord (SessionLedger.recordVerify + parse). Tested.
- [x] 4. **Sidebar badge**: `✓/✗/⊘` on worktree agents via Workspace.verifyInfo (HEAD/dirty
      staleness from WorktreeManager.headState); tooltip with ranAt + state.
- [x] 5. **Studio `verify` field** (AgentForm worktree section): stack-suggested chips
      (Workspace.verifyCandidates = detectStack + package.json scripts + declared command/runbook
      names) the human picks/overrides; persists to yml via toEntry/fromDef. nls (en+pt-br).
- [x] 6. **MCP**: `list_agents` exposes the verify handoff; `verify_agent` tool runs the gate +
      returns {command, passed, atCommit, ranAt, stale}. Tool count 19 → 20; tests updated.
- [x] 7. **Extension action** `tachyon.verifyAgentItem` (inline ✓ on `-verifiable` worktree
      agents) + palette-hidden; package.json + nls (en+pt-br).
- [x] 8. **Docs**: README worktree section (verify-gate + handoff), Bridge tools table 18 → 20
      (+ verify_agent, + the missing update_pin), site worktree section + 19 → 20 MCP tools.
- [x] 9. **Live smoke** — validated headlessly against REAL git + REAL tmux in
      `test/unit/verifyGate.integration.test.ts` (5 cases: pass, fail, cwd/env threading,
      stale-after-commit, runbook expansion) — the exact verifySteps → runSteps composition
      runVerify uses, running real commands inside a real worktree. The only parts not exercised
      here are the VS Code badge pixels + Studio chips (purely visual; recipe in notes.md §
      Live smoke for a manual confirm after a window reload). MCP transport is E2E in bridge.test.

## Notes
- Reuses commands/runbooks (no new executor). Studio stack-suggestion mirrors Init. Human has
  the final word on the verify command. Advisory only — never blocks merge (human-at-gate).
- TDD + codex dueto, like 210/212/213.

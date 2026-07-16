# 389 — tasks

**Verify:** `npx vitest run test/unit/agentManager.test.ts -t "spec 389" test/unit/engineServiceProtocol.test.ts test/integration/restartModesDogfood.test.ts`
**Dogfood:** `npm run dogfood:restart-modes` (real tmux, private `TMUX_TMPDIR`; evidence `.tachyon/evidence/restart-modes-dogfood/latest.json`)

**Human dogfood (optional EDH):** fixture `test/fixtures/agent-restart-modes-dogfood` (`terminals:` bash loops); F5 Dev Host → **Terminals** tab → ⋯ Restart / Restart new section / Force restart.

- [x] Spec + plan ratified in worktree `grok/agent-restart-modes`
- [x] `RestartOptions` type + `restart(name, opts?)` orchestration; extract `restartFresh`
- [x] Graceful wait + session-only hard kill fallback (no ad-hoc wipe)
- [x] Resume-then-fallback-to-new start phase
- [x] Crash + watch callers pass `{ stop: "force", session: "new" }`
- [x] Bridge `restart_agent` stop/session params + receipt
- [x] Engine `agent.restart` wire input + activity helper
- [x] UI QuickPick for four modes (default graceful+resume)
- [x] Unit tests for matrix + default + force paths
- [x] Update existing restart tests that assume force+new to pass explicit opts
- [x] Headless dogfood on real tmux (force/graceful/fallback/default)
- [x] Verify command green; notes log

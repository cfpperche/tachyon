# Tasks — Spec 246 spawn-contract gate

**Verify:** `cd /home/goat/tachyon && env -u TMUX npx vitest run test/unit/spawnContract.test.ts test/unit/bridge.test.ts test/unit/agentManager.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`

- [x] 1. `src/bridge/spawnContract.ts` — `SpawnContract` type, `validateSpawnContract` (D5), `composeSpawnContractBrief` (D3 caps), constants. Pure, no imports from bridge/manager.
- [x] 2. `test/unit/spawnContract.test.ts` — validator pass/fail table + brief composition. (29 tests)
- [x] 3. `src/bridge/tools.ts` — `spawn_agent` schema + handler: detect ad-hoc AI agent (`cmd && inferKind(cmd)==="agent"`); validate-or-skip; structured reject on fail; compose brief on pass; thread `contract` + `contractSkipReason` to `spawn`; non-silent notify on skip; teach the contract in the description.
- [x] 4. `src/agents/AgentManager.ts` — `SpawnOptions.contract?` + `.contractSkipReason?`; persist on the ledger `def` (D8). Plus `SessionLedger.SessionDef.contract?` + `parseDef` whitelist (`isSpawnContract`) so it survives reload.
- [x] 5. Bridge gate tests (reject AI-no-contract / junk / bad-skip, state-safe) + agentManager D8 persist+reload test.
- [x] 6. Full `env -u TMUX npx vitest run` (968 green) + `npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit` (both clean).

## Acceptance (mirror spec.md)
- [ ] Ad-hoc AI spawn with missing/placeholder slot → structured reject naming slots → retry succeeds.
- [ ] D5 validator rejects junk, passes terse-but-real (table).
- [ ] Brief composed role→contract→instructions→guidance within total cap.
- [ ] Contract persisted as structured metadata (D8).
- [ ] restart/resume/fork + pipeline/schedule not gated (tests).
- [ ] Runtime-neutral: non-claude AI child gated identically (no injected hook) — covered by the handler being runtime-agnostic (`inferKind` recognizes all AI CLIs).
- [ ] Terminal/non-AI exempt; declared-agent invocation not gated in v1.
- [ ] `skip_contract_reason` (≥10) bypasses + recorded non-silently.

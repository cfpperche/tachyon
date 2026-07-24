# 443 — plan

## Approach

1. **Focused handoff** — pure markdown builder + write under `.tachyon/session-continuation/`.
2. **Prepare + spawn** — `prepareContinueTask` validates dest not running; Workspace spawns with `taskBrief`.
3. **Bridge + extension command** — same payload.
4. **Cmd gate (t-6d09e6)** — identity from `runtimeOf`/`binaryOf`; refuse if `isKnownAliveSync`; `ledger.clearResume` on change while stopped.

## Decisions

| Decision | Choice | Rejected |
|----------|--------|----------|
| Context mode v1 | Focused host markdown only | Full transcript default (untrusted bulk) |
| Destination | Different declared agent row | Mutating source cmd |
| Source lifecycle | Leave as-is | Auto-kill source |
| Running dest | Fail closed | Force kill |

## Files

- `src/sessionContinuation/focusedHandoff.ts`, `continueTask.ts`
- `src/agents/cmdRuntimeGate.ts`, `AgentManager.isKnownAliveSync`, `SessionLedger.clearResume`
- `Workspace.studioSubmit` / `continueTaskAcrossRuntime`
- `bridge/tools.ts` `continue_task`
- `extensionOperations` `agent.continue-task`
- unit tests

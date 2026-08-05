# t-adf6bd — concurrent real-agent name collision (measurement)

Agent: workername · 2026-08-05

## Question

Do unit tests that start **real** agents with a **fixed** name (e.g. `worker`) collide when two vitest processes run at once, outside `verify:full`'s host lock?

## Inventory

| File | Real tmux? | Real agent.start / spawn? | Names | Isolation already present |
|------|------------|---------------------------|-------|---------------------------|
| `test/unit/engineService.test.ts` | Yes (private `TMUX_TMPDIR`) | Yes — daemon `agent.start` | Fixed `worker`, then `observer` | `makeSocketTemp` workspace → unique `wsHash`; private tmux tmpdir |
| `test/unit/tmux.real.test.ts` | Yes | Sessions only (not AgentManager) | Fixed session labels | Socket `tachyon-test-${pid}` (+ iso/cm pid sockets) |
| `test/unit/anchor.integration.test.ts` | Yes | Session only | `t-rev` | Socket `tachyon-anchor-${pid}` |
| `test/unit/verifyGate.integration.test.ts` | Yes | Worktree agents, not agent.start | passer/failer/… | Local socket / fixture |
| `workspaceHeadless`, `continuityWiring`, `paneTranscriptBridge`, most `agentManager` | Fake exec | Manager.spawn against fake | Fixed names | No shared server |

**Disease shape (real `agent.start` + fixed agent name + real daemon): 1 file, 2 names** (`worker`, `observer` in engineService only).

Optional-auth codex materializers also listed in `optionalRuntimeAuthCoverage` (`workspaceHeadless`, `continuityWiring`) use **fake** tmux — they do not contend on a host tmux namespace.

## Mechanism

```text
AgentManager.spawn → hasSession(sessionName(wsHash, name))
sessionName = `tachyon-${wsHash}-${agent}`
```

`wsHash = sha256(workspacePath).slice(0, 8)`. Two independent temp workspaces never share a session name, even when the agent string is identical and they share one tmux **server**.

## Controlled repro (no codex; real tmux)

Script: ephemeral vite-node harness (not committed). Shared `TMUX_TMPDIR` + shared socket name; concurrent / sequential AgentManager.spawn with `cmd: sh`.

| Case | Setup | Result |
|------|--------|--------|
| A | Concurrent `worker` ×2, **different** workspaces, shared socket | **Both OK** — sessions `tachyon-<hashA>-worker` and `tachyon-<hashB>-worker` |
| B | Sequential `worker` ×2, **same** workspace/hash, leftover live session | **Fails** — `agent 'worker' is already running` |
| C | Concurrent unique names, different workspaces | Both OK (redundant given A) |

## Original site

`engineService.test.ts` ~694 is the first `agent.start` for `worker` after create/enable/`stop-all`. Workspace is always `makeSocketTemp("tachyon-engine-service-")` → unique path/hash. Private `TMUX_TMPDIR` per run.

On this host the suite **skips** that test (`optional codex credential unavailable` under the agent's redirected home). The 2026-08-04 failure was not re-run green/red here.

## Decisions

1. **Unique-per-run agent names** would not stop concurrent independent engineService runs from colliding via the measured door — they already cannot collide through `hasSession` across different workspaces. Applying that change would be cargo-cult relative to CASE A.
2. **Widening `VERIFY_FULL` lock to every vitest** remains refused (brief / t-fb7025): protects the wrong boundary at high cost.
3. The exact message only appears for **same-wsHash leftover live session** (CASE B). If the 2026-08-04 events were real, next dig is same-hash reuse, incomplete teardown under load, or a path that lands both runners on one workspace/socket identity — not the literal string `worker` alone.

## Outcome

**Refuted** as stated: concurrent vitest + fixed agent name on different workspaces is not sufficient for `already running`. No code change. No `verify:full` (read-only investigation).

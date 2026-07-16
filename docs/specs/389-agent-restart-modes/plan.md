# 389 — plan

## Approach

Expose a **2×2 restart matrix** on one API surface and thread it through Bridge + engine + UI.

```
stop:    graceful | force
session: resume   | new
default: graceful + resume (fallback new)
```

### Core (`AgentManager.restart`)

Refactor current body into `restartFresh` (force replace / new section — today's semantics).

New orchestration:

1. Delivery-lifecycle deny (unchanged).
2. **Stop phase** (if a live non-dead pane exists):
   - `graceful`: `stopGracefully` → poll until dead or `gracefulTimeoutMs` (default `STOPPING_FALLBACK_MS`) → if still alive, **session-only** hard kill (`tmux.killSession`, never `AgentManager.kill` which wipes ad-hoc).
   - `force` + `session=new`: fall through to existing replace path (respawn-pane -k).
   - `force` + `session=resume`: hard-replace via `resume()` / startSessionCommand (no ad-hoc wipe).
3. **Start phase**:
   - `session=resume`: try `resume(name, ledgerRecord)`; on `ResumeUnavailableError` or missing resume block → fall back to `restartFresh`.
   - `session=new`: `restartFresh`.

Injectable `sleep`/`now` only if tests need them; prefer `gracefulTimeoutMs: 0` in unit tests for immediate force-fallback.

### Bridge

`restart_agent` schema:

| field | type | default |
|-------|------|---------|
| `name` | agent name | required |
| `stop` | `graceful` \| `force` | `graceful` |
| `session` | `resume` \| `new` | `resume` |

Receipt text names the effective modes (and whether resume fell back to new).

### Engine protocol

Extend `agent.restart` input from `{ agent }` to optional `stop` / `session`. Validator `hasOnlyKeys` updated. `restartAgentWithActivity` forwards opts. Result method stays `agent.restart`.

### UI

`tachyon.restartAgentItem` / palette restart: `showQuickPick` with four choices; default first item = graceful+resume. Pass modes into `invokeAgentLifecycle` → engine.

### Callers that must stay force+new

| Caller | Why |
|--------|-----|
| `LifecycleMonitor` / crash scheduleRestart | recovery |
| `WatchController` file-change restart | rebuild terminal |
| Human "Restart" toast on crash (optional) | operator may want pick later; keep force+new for one-click recovery |

### Tests

- Unit: matrix modes on AgentManager (graceful wait timeout → session-only kill; force+new respawn; resume path; fallback).
- Bridge tool schema / engine command validation for new fields.
- Sidebar/extension: pure pick labels if extracted; otherwise thin integration.

### Risks

- **Default change** for bare `restart()` — crash/watch must pass force+new or behavior regresses.
- **Ad-hoc wipe**: never route force through `AgentManager.kill`.
- **Long graceful wait** on hung CLIs — surface timeout + force fallback; keep 15s aligned with stop UI.

## Files (expected)

- `src/agents/AgentManager.ts` — opts + orchestration
- `src/bridge/tools.ts` — restart_agent schema
- `src/engine-service/protocol.ts` + `engineService.ts` + `ActivityLogManager.ts`
- `src/extension.ts` — QuickPick + lifecycle invoke
- `src/workspace/Workspace.ts` — crash/watch force+new
- `test/unit/agentManager.test.ts` (+ protocol/bridge as needed)
- `docs/specs/389-agent-restart-modes/*`

## Visual surface

Sidebar Restart becomes a mode picker (labels only). Visual QA: command palette / tree action still finds Restart; pick list copy is clear.

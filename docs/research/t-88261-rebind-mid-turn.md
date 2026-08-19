# t-88261 — Bridge client rebind must not cut a live turn

## Before the fix

The remaining process-replacement path is the persistent-engine rebind:

1. A new engine incarnation starts `Workspace.start()` and schedules
   `ws.clientRebind?.onListenerReady()` (`packages/engine/src/workspace/Workspace.ts:2948–2954`).
2. `BridgeClientRebindCoordinator.onListenerReady()` marks wired survivors and, under the
   default `auto` policy, queues them (`packages/bridge/src/clientRebind.ts:327–351`).
3. `runOne()` preflights only `isRunning`, the generation stamp, and generic resume readiness;
   it then calls `stopGracefully` before calling the injected `resume`
   (`packages/bridge/src/clientRebind.ts:807–850, 609–728`).

This bypasses the t-a281e7 guard because that guard lives in
`AgentManager.assertNotMidTurn()`, called by `AgentManager.resume()` and `restart()`
(`packages/engine/src/agents/AgentManager.ts:4430–4445`). Rebind does not call either lifecycle
door while the survivor is live: it stops the process first, then invokes `resume()` after the
process is dead. By then the guard's `live AND evidenced mid-turn` condition is necessarily false,
so the process replacement has already discarded the turn.

The tmux server/pane does not need to be replaced; the measured restart path preserves it. The
rebind exists to replace the runtime process so its Bridge client reconnects to the new engine.
That replacement is necessary for the current protocol, but it must be refused before teardown
when the target is a live evidenced mid-turn. The correct guard is the existing t-a281e7 guard,
with its existing identity-based exemption for an authenticated self-restart. No force flag or
new turn detector is appropriate.

## Actor × trigger cases

- Tachyon × engine restart/rebind, target live and mid-turn: refuse before stop; old process stays.
- Tachyon × engine restart/rebind, target idle: continue through stop and resume normally.
- Agent × self-restart during rebind, identified by the authenticated reload initiator: keep the
  existing identity exemption; do not broaden it to a force flag.

The test must exercise all three through the coordinator's production preflight door and assert
that the refusal happens before any destructive operation.

## Fail-before / pass-after evidence

With the new preflight guard call temporarily removed (the pre-fix behavior), the required
positive case was red:

```text
FAIL test/unit/bridgeClientRebind.test.ts > ... > t-88261: live mid-turn survivor is refused before stop
AssertionError: expected [ 'worker' ] to deeply equal []
at test/unit/bridgeClientRebind.test.ts:363:24
```

That is the destructive proof: the old path called `stopGracefully` before the assertion. The
idle and identity cases were also run in the same matrix; they remained green under the old path,
which is precisely the compatibility behavior they pin. With the guard restored, all three cases
pass, and the focused rebind suite is `38 passed`; the existing t-a281e7 suite is `9 passed`.

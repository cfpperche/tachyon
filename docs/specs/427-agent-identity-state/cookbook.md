# Cookbook — agent-identity-state

_Operator/agent how-to for this shipped surface. Not the contract (`spec.md`) and not build memory (`notes.md`).
Write at ship time when the change introduces a usable API, Bridge tool, CLI, or lifecycle that a sibling agent
or human would otherwise reverse-engineer from code._

## When to use

- A host-owned launch path needs one immutable formation snapshot for a canonical profile agent.
- The lifecycle orchestrator needs to inspect, recover, retire or import inactive candidates through
  the four lane-local hooks.

## When not to use

- Do not use this path for legacy agents or canonical profiles whose lanes are all disabled; their
  existing prompt/plugin path remains authoritative.
- Do not use it for runtime-native memory, plugin installation, rename/clone/forget ordering or UI.
  Those belong to their dedicated tasks.

## Happy path

1. Read the current `FormationAuthorityVector` and its generation digest from the host authority store.
2. Have the runtime adapter suppress every enabled native equivalent and issue one receipt covering
   the exact operation, vector, adapter and runtime trust class.
3. Call `resolveCompleteFormationPayload(...)`. Every enabled lane must resolve; no partial result is
   returned.
4. Call `prepareResolvedSnapshot(...)` with the same expected generation digest, then `commitFresh(...)`.
5. Persist only the returned session selector. Resume, restart, rebind, re-anchor and same-snapshot
   fork read the immutable snapshot selected by that record; they never re-read profile sources.
6. After a human-approved Evolution or memory promotion, create a new fresh formation to observe the
   new generation. Existing selectors continue to expose their original bytes.

## Tools / commands

| Action | Tool or command | Notes |
|--------|-----------------|-------|
| Run focused formation matrix | `npm test -- test/unit/agentFormation*.test.ts test/unit/evolutionPromptLayers.test.ts test/unit/soulProfileTransactions.test.ts` | Includes migration, recovery, tamper and plugin compatibility. |
| Run isolated dogfood | `npm test -- test/unit/agentFormationDogfood.test.ts` | Covers fresh, promotion, next session, resume, re-anchor and fork. |
| Verify PI-001 | `npm run test:invariants` | Promise/oracle and legacy prompt behavior must remain unchanged. |
| Verify repository | `npm run typecheck && npm run verify:full:quiet` | Required before landing. |

## Fail-closed / safety

- A missing, stale, corrupt or mismatched required lane fails the complete resolution.
- A renderer-set or authority-vector mismatch fails before snapshot publication.
- A suppression receipt that omits an enabled lane, changes trust class or belongs to another
  operation/vector is rejected.
- Existing selectors reject ownership, `agentId`, trust-class and formation-affecting runtime changes.
- Plugin state is absent from the formation vector, snapshot and lifecycle hook map.

## Cleanup

1. Retire formation authority through the lifecycle owner before deleting profile-owned bytes.
2. Revoke session-selector roots when resumability should end; descendants are revoked with them.
3. Run the authority store's garbage collection only after leases and reachable selectors are
   accounted for. Never remove content-addressed objects directly.

## See also

- Contract: [`spec.md`](./spec.md)
- Build decisions and verification: [`notes.md`](./notes.md)
- Cross-lane lifecycle owner: task `t-e50d4f`
- Runtime-native memory architecture: task `t-d4c42e`

# 412 — ledger-contract-completion — plan

_Drafted from `spec.md` on 2026-07-19._

## Approach

Add one pure completion-classification helper beside `SpawnContract`, and use it at both trust
boundaries. `SessionLedger.parseDef` will restore only structurally valid contracts; if a contract
field exists but is malformed, it will retain a content-free invalid sentinel on the session
definition. `AgentManager.restart` will read the ledger definition once and reject that sentinel
before composing/writing a brief or touching tmux. `effectiveInstructions` will also use the closed
helper and reject any invalid in-memory contract rather than falling back to `done_when`.

## Key decisions

- **Retain a content-free invalid sentinel** — chosen so one malformed nested contract does not erase
  the whole session row, while restart still fails visibly; rejected silently dropping the field
  because that would turn corruption into an unstructured-task restart without a diagnostic.
- **Classify completion in the pure contract module** — chosen to keep parser and renderer semantics
  identical; rejected duplicating boolean expressions because that recreates the drift being fixed.
- **Structural ledger validation, substantive Bridge validation** — chosen for compatibility with
  already-supported persisted contracts; rejected rerunning all fresh-spawn prose heuristics during
  reload because future validator changes must not invalidate old but structurally sound sessions.

## Files touched

- `src/bridge/spawnContract.ts` — closed structural completion classifier.
- `src/resume/SessionLedger.ts` — strict persisted-contract parser plus invalid sentinel.
- `src/agents/AgentManager.ts` — explicit completion classification and pre-mutation restart refusal.
- `test/unit/spawnContract.test.ts` — classifier table.
- `test/unit/resume.test.ts` — four persisted contract shapes.
- `test/unit/agentManager.test.ts` — long restart and fail-closed tmux behavior.

## Risks & unknowns

- Empty strings must not count as a completion even if the property exists.
- Invalid-contract state must survive parsing without leaking free-form values.
- Restart refusal must happen before brief replacement and tmux mutation.

## Visual impact

None. This is an internal persistence and diagnostic boundary.

## Sources consulted

- `src/bridge/spawnContract.ts` (`SpawnContract`, `validateSpawnContract`).
- `src/resume/SessionLedger.ts` (`parseDef`, current `isSpawnContract`).
- `src/agents/AgentManager.ts` (`effectiveInstructions`, restart pre-mutation ordering).
- `docs/specs/411-startup-brief-semantics/` and task `t-c8949c`.

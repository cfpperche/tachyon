# 412 — ledger-contract-completion

_Created 2026-07-19._

**Status:** shipped
**Closure:** Shipped in `5703133d`; persisted contracts now use a closed completion discriminator,
malformed records retain a content-free sentinel, and restart refuses them before session mutation.

## Intent

`SessionLedger` currently restores any object with string `task`, `context` and `constraints` as a
`SpawnContract`, even when its completion shape is impossible. `AgentManager` then treats every
contract without `deliverable` as `DONE_WHEN`. A legacy or corrupted ledger with neither completion
field can therefore be described falsely on restart.

Persisted structured contracts must use the same closed completion discriminator as fresh spawns:
exactly one non-empty `deliverable` or `doneWhen`. Valid records retain their completion kind;
invalid records remain visibly invalid and restart fails before mutating the live session, with a
bounded diagnostic that never prints contract content.

Affected Product Invariants: none — defensive validation of internal ledger data; PI-001 and its
project-guidance oracle are unchanged.

## Acceptance criteria

- [x] **Scenario: valid DELIVERABLE survives reload**
  - **Given** a persisted contract with exactly one non-empty `deliverable`
  - **When** the ledger is parsed and the agent is restarted
  - **Then** the contract is restored as `deliverable` and a long startup brief reports `DELIVERABLE`
- [x] **Scenario: valid DONE_WHEN survives reload**
  - **Given** a persisted contract with exactly one non-empty `doneWhen`
  - **When** the ledger is parsed and the agent is restarted
  - **Then** the contract is restored as `done_when` and a long startup brief reports `DONE_WHEN`
- [x] **Scenario: missing completion fails closed**
  - **Given** a ledger contract with neither completion field
  - **When** restart is requested
  - **Then** restart is refused before respawn/session replacement and the diagnostic names only the
    invalid completion shape
- [x] **Scenario: ambiguous completion fails closed**
  - **Given** a ledger contract with both completion fields
  - **When** restart is requested
  - **Then** restart is refused before respawn/session replacement and no contract body is printed
- [x] Fresh Bridge spawns continue using the existing substantive contract validator.
- [x] No code path derives `done_when` merely from the absence of `deliverable`.

## Non-goals

- Repairing or guessing the intended completion field of a malformed ledger.
- Changing the public valid `SpawnContract` schema or weakening fresh-spawn validation.
- Rejecting the entire sessions ledger because one nested contract is malformed.
- Changing startup-brief transport, limits, precedence or PI-001.

## Open questions

None. The task contract already selects fail-closed restart with content-free diagnostics.

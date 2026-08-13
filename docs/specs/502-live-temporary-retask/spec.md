# 502 — live-temporary-retask

_Created 2026-08-13._

**Status:** shipped
**Closure:** shipped in `a24f0097`; live retask claims one board task and queues a fresh WORK ON RECORD without lifecycle or checkout mutation, verified by the full gate on tree `f164fe5804fc` before closure-only metadata.
**Verify:** `npx vitest run test/unit/bridge.test.ts test/unit/agentManager.test.ts test/unit/sessionWorkRecord.test.ts test/unit/primer.test.ts`
**Dogfood-Opt-Out:** the production Bridge door is exercised through its registered MCP handler with real task-store and notice-queue test doubles; no existing dogfood scenario targets live agent retasking.
**Visual QA Opt-Out:** no graphical surface changes; the visible result is framed terminal protocol asserted byte-for-byte in tests.
**Cookbook:** yes
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

A live Temporary agent can be assigned different work on the board, but its frozen WORK ON RECORD
does not change. `restart_agent(session:new)` rereads the board and preserves its checkout, but
throws away the conversation; `session:resume` preserves the conversation but does not reread the
record. The missing operation is a deliberate retask that updates the board authority and injects
its fresh projection into the existing conversation without running any lifecycle or checkout path.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: retask a live Temporary**
  - **Given** a ready Temporary agent and a triaged, unassigned task
  - **When** an authorized caller invokes the retask door
  - **Then** the task becomes active and assigned, and the existing conversation receives a fresh WORK ON RECORD naming it
- [x] **Scenario: preserve checkout identity**
  - **Given** a Temporary agent whose ledger records a worktree path and branch
  - **When** it is retasked
  - **Then** the same ledger path and branch remain and no spawn, restart, dismiss, or worktree resolver runs
- [x] **Scenario: do not choose between live tasks**
  - **Given** the agent still owns a different active task
  - **When** a caller tries to retask it
  - **Then** the door refuses before changing the board and tells the caller to finish or release the old assignment
- [x] **Scenario: delivery is not silently lost**
  - **Given** the agent is busy when retasked
  - **When** the fresh record cannot be submitted immediately
  - **Then** the queue-safe delivery path retains it for the agent's next idle edge
- [x] The report explicitly records that WORK ON RECORD is reread at launch/fresh restart, not each turn, and that live retask therefore requires a push.

## Non-goals

- Changing `kill_agent` or `dismiss` cleanup semantics.
- Weakening the primer's conflict rule.
- Deciding that an old active task is complete or changing its status automatically.
- Replacing general task triage or assignment tools.

## Open questions

None. Measurement selected an in-conversation push over restart.

## Measurements and decisions

- `sessionWorkRecordFor` reads the live board while composing spawn or fresh-restart prompts. There is no turn-start reread; `session:resume` deliberately injects no prompt.
- A live correction therefore needs a push. `retask_agent` reuses queue-safe `deliverNotice` and carries the newly rendered record in its body; no transport or lifecycle mechanism was added.
- Fresh restart was rejected because it loses conversation context. Implicitly releasing old work was rejected because the product cannot decide whether it is finished; competing active ownership refuses by name.
- The focused production-door test asserts queued delivery and exact worktree/branch ledger equality. The full gate passed 8223 tests on the implementation tree.

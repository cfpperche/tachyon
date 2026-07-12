# 373 — token-efficient-agent-fleet

_Created 2026-07-11._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The current declared Codex fleet uses the same Sol-medium model family for implementation and review, leaves
verification cadence implicit, and has no objective context-rotation threshold. That spends the scarce Sol quota on
bounded work, weakens reviewer independence, encourages repeated full-suite output, and lets long-lived transcripts
accumulate even after a task boundary.

Make the maintainer's seven-point operating policy durable and mechanically inspectable: Sol xhigh coordinates,
Terra medium implements closed contracts, Luna low handles deterministic mechanical corrections, Claude Sonnet
reviews immutable candidates, full verification runs only at the first reviewable candidate and final closure, and
the coordinator batches its own audit findings before one correction handoff. Keep declared agents alive while a task
is active, but rotate to a proven fresh conversation between tasks once context reaches roughly 35–40%. This spec is
dependent on spec 372, which supplies the quiet full-verification command used by the cadence here.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [ ] **Scenario: coordinator stays in the expensive reasoning lane only**
  - **Given** the declared `codex` coordinator
  - **When** its command and durable role instructions are inspected
  - **Then** it uses Sol xhigh and is confined to architecture, concurrency/security reasoning, task decomposition,
    coordination, complete pre-handoff audit, final acceptance, and integration rather than implementation or routine
    review execution
- [ ] **Scenario: closed implementation contracts use Terra medium**
  - **Given** the coordinator has already fixed the architecture, invariants, interfaces, failure behavior, owned
    scope, test matrix, and done condition
  - **When** it delegates implementation
  - **Then** the declared executor launches with authenticated `gpt-5.6-terra` at medium effort, with no silent model
    fallback
- [ ] **Scenario: deterministic corrections use Luna low**
  - **Given** a correction is mechanical, bounded, and protected by explicit automated checks
  - **When** the coordinator delegates it
  - **Then** a separately declared mechanical executor launches with authenticated `gpt-5.6-luna` at low effort and
    receives no open architecture or design choice
- [ ] **Scenario: independent review uses another provider quota**
  - **Given** an immutable implementation candidate and a closed review contract
  - **When** the coordinator requests independent review
  - **Then** the declared reviewer launches as Claude Sonnet, stays read-only except for its review artifact, and
    reports severity-ranked findings against the whole candidate
- [ ] **Scenario: full verification has two deliberate checkpoints**
  - **Given** one task progresses through implementation, review findings, and corrections
  - **When** gates are selected
  - **Then** `npm run verify:full:quiet` runs for the first reviewable candidate and once again for final closure;
    intermediate corrections run focused tests, typecheck, and diff-check, unless an extra full run has an explicit
    global-regression reason recorded in the task journal
- [ ] **Scenario: coordinator batches its correction audit**
  - **Given** an executor delivery or reviewer finding set
  - **When** the coordinator prepares the next correction round
  - **Then** it first audits the complete immutable delta, contract coverage, surrounding failure paths, and test
    truthfulness, records all findings in one durable artifact or task note, and sends one closed correction contract
    instead of returning findings piecemeal
- [ ] **Scenario: context rotation is bounded and genuinely fresh**
  - **Given** a declared executor or reviewer has finished its current task and its transcript is approximately
    35–40% full
  - **When** the next task is ready
  - **Then** the coordinator checkpoints current state, restarts the declared agent into a new runtime conversation,
    re-anchors its role, confirms the new session identity/readiness, and only then assigns the next task; it never
    rotates mid-task or uses resume as if it cleared context
- [ ] **Scenario: healthy task-local sessions remain alive**
  - **Given** a declared agent is working or idle within the same task and below the rotation threshold
  - **When** no crash, contamination, model/config change, or slot conflict exists
  - **Then** it is kept alive; idle time is not treated as token consumption and restart is not represented as a
    reset of the provider's five-hour rate-limit window
- [ ] Spec 372 is shipped first and `settings.verify.full` resolves to `npm run verify:full:quiet` before this fleet
  policy is activated.

## Non-goals

- Resetting, bypassing, predicting, or accounting for provider rate-limit windows.
- Weakening test coverage, review rigor, delivery isolation, authorization, or the final full gate.
- Rotating an agent in the middle of an active task or killing idle agents merely to save tokens.
- Automatically making architectural decisions with Terra/Luna or accepting an executor's self-review.
- Changing the global `verify_task` default for repositories other than this workspace.
- Building a generic scheduler or runtime usage dashboard.

## Open questions

None. The maintainer ratified the seven-point policy on 2026-07-11. Repository evidence confirms that declared
Codex/Claude restart creates a fresh conversation while preserving the worktree, whereas resume replays the existing
transcript; implementation must preserve and test that distinction.

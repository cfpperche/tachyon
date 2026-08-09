# 413 — create-task-authoring-guidance

_Created 2026-07-19._

**Status:** shipped
**Closure:** Shipped 2026-07-19 in `18ae6dfb`: `create_task` retains canonical MCP schema bounds while returning bounded, content-free received/max errors with deliberate umbrella/follow-up, task-note, and durable-artifact guidance; TaskStore shares the limits and rejects atomically. Evidence: focused MCP/TaskStore tests 95/95, PI-001 2/2, typecheck pass, full verification 437 files and 5,036 passed / 3 skipped, and headless dogfood pass.
**Verify:** `npx vitest run test/unit/bridge.test.ts test/unit/taskStore.test.ts`
**Dogfood:** `npx vitest run test/unit/bridge.test.ts -t "create_task rejects oversized authoring input atomically with decomposition guidance"`
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

`create_task` currently rejects oversized input through the MCP SDK's generic Zod error. The response reports a schema failure but does not explain how to preserve a large body without truncation, when to split independently shippable work into follow-up Tasks, or which existing surfaces hold chronological notes and durable artifacts. This makes the safe authoring path discoverable only after human intervention.

Make every `create_task` size failure specific, bounded, and actionable while preserving the public schema limits and TaskStore's defensive validation. Rejection must remain atomic: invalid input creates no Task, no notification, and no partial artifact. The tool should teach decomposition but never create follow-ups or infer dependencies automatically.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: oversized body is rejected with a preservation path**
  - **Given** a `create_task` body longer than 4,000 code points
  - **When** the caller invokes the tool
  - **Then** the bounded error names `body`, reports received and maximum sizes, says not to truncate, and distinguishes an umbrella Task plus explicit follow-up Tasks, `append_task_note`, and `artifact_refs`
  - **And** no Task, notification, dependency, or partial file is created
- [x] **Scenario: real four-slice work is decomposed deliberately**
  - **Given** one request describes four independently shippable slices
  - **When** the caller reads `create_task` guidance or an oversized-body error
  - **Then** it is told to create one bounded umbrella Task and separate follow-up Tasks, without automatic follow-up creation or dependency inference
- [x] **Scenario: other authoring limits identify the failing field**
  - **Given** an oversized title, kind, artifact-ref collection, artifact-ref type, or artifact-ref value
  - **When** the caller invokes `create_task`
  - **Then** the error names that field and reports its received and maximum sizes with field-specific remediation
- [x] The advertised MCP JSON schema retains the canonical maxima: title 300, body 4,000, kind 64, artifact refs 10, ref type 64, and ref value 500.
- [x] TaskStore uses the same canonical limits and emits the same concise limit vocabulary for non-MCP callers.
- [x] Product Invariants are unchanged; PI-001 remains enforced by its existing verification.

## Non-goals

- Automatically create umbrella or follow-up Tasks.
- Infer or mutate Task dependencies.
- Increase limits, truncate author input, or embed long artifacts in Task bodies.
- Change `update_task`, notification delivery, Task lifecycle, or Mission Control UI.

## Open questions

None. The task contract supplies the authoring policy and the existing MCP/TaskStore boundaries supply the enforcement points.

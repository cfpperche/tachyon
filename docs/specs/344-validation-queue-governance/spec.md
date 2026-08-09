# 344 — validation-queue-governance

_Created 2026-07-03._

**Status:** shipped
**Closure:** Implemented standalone Validation queue under `.tachyon/validations/`, Bridge validation tools, discovery candidates, `next_validation`, and Mission Control pending/closure UI. Evidence after Opus review fixes: `npm test -- test/unit/bridge.test.ts test/unit/auth.test.ts test/unit/boardSnapshot.test.ts test/unit/missionControlPanel.test.ts test/unit/validationStore.test.ts test/unit/nextValidation.test.ts test/unit/validationDiscovery.test.ts && npm run typecheck && npm run build`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npm test -- test/unit/validationStore.test.ts test/unit/nextValidation.test.ts test/unit/bridge.test.ts && npm run typecheck && npm run build`

## Intent

Tachyon can already prove mechanical gates (`verify`, unit tests, builds) and can record advisory evidence, but real project readiness also depends on validation work that is easy to forget: human dogfood, exploratory QA, install checks, release smoke tests, agent-run checks, customer-demo rehearsal, or any project-specific proof that a change works in practice.

Today these validations are scattered across spec notes, chat messages, pins, and human memory. That creates governance drift: a task/spec can look technically complete while an important "someone must actually try this" step remains pending and invisible.

Done means Tachyon has a first-class **Validation** queue, independent from the SDD plugin, where humans and agents can discover existing validation debt, create/triage/assign validation items, execute them, and close each validation round with evidence or an explicit reason. "Dogfood" becomes one common validation type, not the product name or a required workflow.

V1 stores validations as a standalone project entity under `.tachyon/validations/`, not as a Task subtype. Tasks remain implementation work; Validations are proof/governance work. A Task may link to validations, but Task status and Validation status do not collapse into one another.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: create an open validation**
  - **Given** a project has a feature, task, pin, spec, or manual concern that needs real-world proof
  - **When** a human or agent creates a validation item
  - **Then** Tachyon persists a validation with a title, free-form `type`, executor target, lifecycle status, priority, optional assignee, source links, and optional instructions.
- [x] **Scenario: discover existing validation debt**
  - **Given** existing specs, pins, tasks, or notes mention pending dogfood/manual validation work
  - **When** the validation discovery/import flow runs
  - **Then** Tachyon surfaces candidate validations for triage instead of leaving them buried in prose.
- [x] **Scenario: project-specific validation type**
  - **Given** a project uses a validation label Tachyon does not know, such as "red-team prompt pass" or "tenant migration rehearsal"
  - **When** the validation is created with that type
  - **Then** Tachyon stores and displays the type without rejecting it or requiring a plugin update.
- [x] **Scenario: human-owned pending validation**
  - **Given** a validation requires maintainer judgement, visual inspection, or installed-build dogfood
  - **When** it is assigned to `human`
  - **Then** agents do not auto-claim it as executable work, and Mission Control surfaces it as pending human validation.
- [x] **Scenario: agent-executable validation**
  - **Given** a validation has enough instructions for an agent to run
  - **When** an agent claims or is assigned the validation
  - **Then** the agent can mark it running, attach evidence, and close it as passed/failed/skipped.
- [x] **Scenario: closure requires evidence or reason**
  - **Given** a validation round is closed as `passed`, `failed`, or `skipped`
  - **When** the status change is saved
  - **Then** Tachyon records at least one evidence pointer, note, or skip/failure reason so the closure is auditable.
- [x] **Scenario: failed validation can be re-run**
  - **Given** a validation round closed with outcome `failed`
  - **When** the work is fixed and someone reopens the validation
  - **Then** Tachyon preserves the failed round and starts a new round instead of overwriting the old result.
- [x] **Scenario: source stays optional and open**
  - **Given** a validation came from an SDD spec, Mission Control task, pin, external issue, or ad-hoc conversation
  - **When** it is linked to its origin
  - **Then** the source is stored as open artifact references, and projects without SDD remain fully functional.
- [x] Validations are visible from Mission Control as a governable queue/filter, not only inside individual specs or pins.
- [x] Mission Control's default project view makes pending validations visible via a badge, section, or equivalent signal; hidden validation debt is not acceptable.
- [x] Validation status is separate from Task status: a Task can be implementation-complete while related validations remain pending.
- [x] Validation storage uses project-local durable files under `.tachyon/` and tolerates concurrent humans/agents using CAS or equivalent precondition checks.

## Non-goals

- Does not make the SDD plugin a dependency.
- Does not rename the feature to Dogfood or require dogfood-specific semantics.
- Does not enforce a closed enum for validation type/kind labels.
- Does not replace automated verify gates; validations complement verify.
- Does not require every Task to have validations.
- Does not implement release blocking policy in v1.
- Does not ship `blocksRelease` in v1; release gating should be a later policy layer.
- Does not solve custom project workflow columns in Mission Control; validations get their own minimal lifecycle for v1.

## Resolved questions

- Mission Control shows Validations as a compact separate signal/closure strip above the task board for v1; it does not create another task column.
- Discovery produces reviewable candidates first; it never auto-creates validations.
- Agents receive a separate `next_validation` tool; validations do not participate in `next_task`.

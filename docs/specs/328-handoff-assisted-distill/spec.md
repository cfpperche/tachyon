# 328 — handoff-assisted-distill

_Created 2026-07-02._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Project Handoff v1 already has the correct persistence model: one canonical `.tachyon/HANDOFF.md`
plus append-only pending notes that can be folded by `set_project_handoff(..., distilled_through)`.
What is missing is a humane way for the owner to ask an agent to do that fold without manually
copying context and tool instructions into a terminal.

Done means the Handoff panel can start an assisted distillation task against the existing handoff
state. The owner chooses either a running Tachyon agent or a fresh ad-hoc runtime, optionally adds
instructions, and Tachyon sends a bounded prompt that tells the agent to draft a canonical rewrite
from `get_project_handoff` and only apply it with explicit human approval.

## Acceptance criteria

- [ ] **Scenario: distill with an existing agent**
  - **Given** the Handoff panel is open and at least one AI agent is running in the workspace
  - **When** the owner opens Distill, chooses that agent, adds an optional instruction, and starts
  - **Then** Tachyon sends a distillation prompt to that agent's terminal without directly changing `.tachyon/HANDOFF.md`
- [ ] **Scenario: distill with an ad-hoc runtime**
  - **Given** the Handoff panel is open
  - **When** the owner opens Distill, chooses an ad-hoc runtime, adds an optional instruction, and starts
  - **Then** Tachyon spawns a dedicated ad-hoc agent with the same distillation contract
- [ ] **Scenario: no silent write**
  - **Given** pending notes exist
  - **When** a distillation task is started
  - **Then** the task prompt instructs the selected agent to ask for human approval before calling `set_project_handoff`
- [ ] The prompt tells the agent to use `get_project_handoff`, preserve `expected_revision`, and pass `distilled_through` from the snapshot it used.
- [ ] The feature reuses the existing pending-note lane; it does not create a second candidate queue.
- [ ] The panel still supports the existing Open/Refresh behavior.
- [ ] The UI is visually inspected because this changes an editor webview.

## Non-goals

- No automatic LLM rewrite/application from the host process.
- No new handoff persistence format, queue, or candidate store.
- No external sharing or Activity item sharing changes.
- No semantic merge algorithm for concurrent handoff rewrites beyond the existing CAS contract.

## Open questions

- Should the ad-hoc runtime list be dynamic by installed binary? For this pass, keep the runtime set explicit and small (`codex`, `claude`) and let the spawn path surface missing-binary errors.

# 452 — agent-studio-canonical-trust-copy

_Created 2026-07-25._

**Status:** shipped
**Closure:** Canonical New/Edit Agent now discloses the bounded native trust authorization beside
Working directory, with localized copy, regression coverage, and desktop/narrow Visual QA evidence.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The canonical runtime adapters now pre-authorize native project trust only for the workspace root and
effective cwd, but Agent Studio does not disclose that consequence. New/Edit Agent must explain the
bounded authorization next to Working directory without implying broader approval, sandbox, or hook
trust bypass.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: Canonical trust disclosure in New and Edit**
  - **Given** a canonical New Agent or Edit Agent form
  - **When** the Working directory control is rendered
  - **Then** localized help states that enable/start authorizes native folder trust only for the
    current workspace and effective cwd
- [x] The help explicitly states that general approvals, sandbox policy, and arbitrary hook trust are
  unchanged.
- [x] Legacy forms do not claim the canonical trust contract.
- [x] Save, enable, start, serialization, dirty state, and validation behavior remain unchanged.
- [x] Desktop and narrow visual captures preserve form hierarchy without introducing overflow or control
  crowding.

## Non-goals

- Changing adapter trust behavior or lifecycle actions.
- Adding confirmation dialogs or new persisted form fields.
- Redesigning unrelated Agent Studio sections.

## Open questions

None.

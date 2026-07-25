# 459 — claude-stop-draft

_Created 2026-07-25._

**Status:** shipped-partial
**Closure:** Claude draft stop now uses the measured local `/exit` after Ctrl+C. Active-turn stop
and a typed authored permission policy remain explicitly deferred because producing a real active
turn would require an authorized model interaction.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Claude Code 2.1.220 clears an unsubmitted composer draft with Ctrl+C, but does not exit after the
previous Ctrl+D retry sequence. A real non-billable TTY measurement established that its local
`/exit` command cleanly ends the session after clearing the draft.

Make the measured draft-safe sequence the runtime behavior while preserving the active-turn limit:
no model request is sent merely to create an active turn, so that scenario remains explicitly
unverified until separately authorized.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: drafted Claude composer**
  - **Given** a live Claude 2.1.220 TUI with unsubmitted text
  - **When** graceful stop clears it and the pane remains alive
  - **Then** Tachyon submits the local `/exit` command rather than relying on Ctrl+D.
- [x] The runtime profile and AgentManager model conditional text submission explicitly and cover it
  in unit tests.
- [x] Active-turn behavior remains labelled unverified rather than inferred from the draft result.

## Non-goals

- Send a billable model prompt to produce a live active turn.
- Synthesize a canonical Claude permission policy from the CLI precedence measurement.

## Open questions

Whether a real active Claude turn accepts Escape, Ctrl+C, and `/exit` without a provider prompt. It
requires explicit authorization for a billable model interaction.

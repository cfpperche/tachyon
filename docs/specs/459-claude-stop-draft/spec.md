# 459 — claude-stop-draft

_Created 2026-07-25._

**Status:** shipped
**Closure:** Claude draft and authorized active-turn stop use the measured local `/exit` after
Ctrl+C; the active pane exited with status 0. A typed authored permission policy remains intentionally
unavailable because Tachyon has no corresponding profile field.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Claude Code 2.1.220 clears an unsubmitted composer draft with Ctrl+C, but does not exit after the
previous Ctrl+D retry sequence. A real non-billable TTY measurement established that its local
`/exit` command cleanly ends the session after clearing the draft.

Make the measured draft-safe sequence the runtime behavior and verify it against an authorized
active turn.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: drafted Claude composer**
  - **Given** a live Claude 2.1.220 TUI with unsubmitted text
  - **When** graceful stop clears it and the pane remains alive
  - **Then** Tachyon submits the local `/exit` command rather than relying on Ctrl+D.
- [x] The runtime profile and AgentManager model conditional text submission explicitly and cover it
  in unit tests.
- [x] An authorized active Claude turn accepts the sequence and exits its pane with status 0.

## Non-goals

- Synthesize a canonical Claude permission policy from the CLI precedence measurement.

## Open questions

None for graceful stop. The intentionally unavailable typed Claude policy is surfaced as a canonical
runtime limitation rather than synthesized from CLI flags.

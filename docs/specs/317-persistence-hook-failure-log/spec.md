# 317 — persistence-hook-failure-log

_Created 2026-07-01._

**Status:** shipped
**Closure:** Shipped in this workspace as spec 317 implementation; final commit/VSIX recorded after validation. Evidence: `npm test -- test/unit/sessionOwners.test.ts test/unit/harness.test.ts` and `npm run typecheck`.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The v1 hook scripts are deliberately best-effort and should not break Claude/Codex when Tachyon's bookkeeping fails.
However, swallowing failures completely makes silent persistence hard to debug. Tachyon needs a durable, bounded failure
log for hook scripts that preserves runtime safety while giving the user and diagnostics code something concrete to
inspect.

Done means hook script failures are captured in a machine-readable log with enough context to diagnose the failure,
while hook processes still exit safely according to each runtime's expectations.

## Acceptance criteria

- [x] **Scenario: hook script failure is recorded**
  - **Given** a Tachyon persistence hook script hits an expected filesystem or parse failure
  - **When** the script exits
  - **Then** `.tachyon/activity/persistence-hooks.log` or a JSONL equivalent records the failure with agent, hook event,
    timestamp, and sanitized error message
- [x] **Scenario: runtime is not blocked by logging**
  - **Given** failure logging itself cannot write
  - **When** the hook script exits
  - **Then** the runtime is not trapped in a hook failure loop
- [x] **Scenario: diagnostics can consume failures**
  - **Given** failures exist in the log
  - **When** spec 316 health diagnostics computes hook state
  - **Then** it can classify the agent as failed and point to the latest relevant row
- [x] Logged errors must not include raw secrets, full hook stdin payloads, or unbounded stack traces.
- [x] Log schema is intentionally minimal: agent, event, timestamp, sanitized reason, script id/version, and enough path
  context to debug within the workspace.
- [x] The log format is append-only and compatible with later retention in spec 319.

## Non-goals

- Build the final UI surface for failures; spec 316 owns display.
- Rotate/prune logs; spec 319 owns retention.
- Turn hook failures into visible pane text.
- Add semantic handoff/continuity generation.

## Open questions

- **OQ1 — Log name and schema.** Initial preference: JSONL under `.tachyon/activity/` so existing tolerant ledger patterns apply.
- **OQ2 — Data sensitivity.** Treat hook logs as local diagnostic state only; do not copy prompt content, tool payloads, or
  secrets from hook stdin.

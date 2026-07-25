# 458 — parity-readiness

_Created 2026-07-25._

**Status:** shipped-partial
**Closure:** Readiness now projects runtime evidence and adapter fork support into Agent Studio, where
localized limitations appear before lifecycle actions. Focused Studio tests, `npm run typecheck`, and
`npm run verify:full:quiet` passed; visual capture remains explicitly unavailable because the
provisioned browser launcher is missing from this worktree.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

The canonical parity work established a truthful baseline for Codex, Claude, Grok, and Pi, but an
operator creating or enabling a canonical agent cannot see those runtime-specific limits at the
moment of action. That makes a verified baseline look like total parity.

Expose the effective canonical runtime readiness before lifecycle Enable/Start actions. The surface
must say what is limited without duplicating capability claims in the webview, and it must never
turn a limitation into a false promise of parity.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: lifecycle readiness**
  - **Given** an operator opens a canonical Agent Studio profile
  - **When** they reach the lifecycle controls before enabling or starting it
  - **Then** the effective runtime baseline and each applicable limitation are visible beside those controls.
- [x] Readiness is projected from structured runtime capability evidence, while localized UI copy maps
  stable limitation codes to human text.
- [x] Codex fork unavailability, Claude/Grok partial policy evidence, and Pi one-live OAuth admission
  remain explicit without blocking unrelated lifecycle operations.
- [x] Visual-QA preflight and its unavailable result are recorded without claiming a visual inspection.

## Non-goals

- Implement a new fork primitive, permission-policy projection, or concurrent Pi OAuth flow.
- Make readiness a new authorization gate or change existing lifecycle behavior.
- Claim a runtime has total parity.

## Open questions

None.

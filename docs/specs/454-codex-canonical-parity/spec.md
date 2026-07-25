# 454 — codex-canonical-parity

_Created 2026-07-25._

**Status:** shipped
**Closure:** Codex canonical permission metadata and the summary matrix now match the private-home
lifecycle evidence; fork remains explicitly unavailable.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Codex canonical profiles already materialize the selected approval policy and sandbox mode into a
private `CODEX_HOME` on fresh spawn, restart, and resume, but the runtime profile and summary matrix
understate that evidence. This leaves Agent Studio and operators unable to distinguish an actual
canonical permission posture from an unverified claim.

Record the measured Codex permission modes, keep the lack of native fork explicit, and reconcile the
summary matrix with the lifecycle tests and private-home projection.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: canonical permission lifecycle**
  - **Given** a canonical Codex profile selects an approval policy and sandbox mode
  - **When** the agent is spawned, restarted, or resumed
  - **Then** the exact selected values are regenerated in its private `CODEX_HOME/config.toml`, without
    ambient config or sibling trust entries.
- [x] Runtime metadata lists the measured Codex approval and sandbox modes and records their source.
- [x] The summary matrix marks graceful stop, permission injection, and native configuration parity
  consistently with the verified implementation.
- [x] Native fork remains explicitly unavailable for Codex; no synthetic fork behavior is introduced.

## Non-goals

- Adding Codex native fork support.
- Broadening the closed native-config allowlist or adding Runtime Config writes.
- Changing approval or sandbox values selected by an existing canonical profile.

## Open questions

None.

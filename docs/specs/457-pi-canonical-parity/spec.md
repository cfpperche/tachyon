# 457 — pi-canonical-parity

_Created 2026-07-25._

**Status:** shipped-partial
**Closure:** Existing private-home, fork/admission and Soul lifecycle evidence was audited against Pi 0.80.10. Offline print mode emits only a session envelope, so no headless probe was added; OAuth concurrency remains the one-live-Pi admission limit.
**Dogfood:** `{{representative headless dogfood command}}`
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Pi already has a private home, exact-resource harness, measured composer/stop behavior, a safe
Delivery reviewer posture, and a native fork command. The canonical parity baseline must make the
remaining limitation explicit: Pi's OAuth lock is path-scoped, so independent private homes cannot
rotate one account concurrently. It must also establish whether the installed CLI exposes a safe,
non-billable headless probe and record Soul delivery accurately.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: canonical Pi lifecycle**
  - **Given** a Pi canonical profile with private auth/settings/resources and workspace trust
  - **When** it is spawned, restarted, and resumed
  - **Then** trust is regenerated exactly while auth and private runtime state remain isolated.
- [x] Pi fork and OAuth concurrency are either verified safe or remain an explicit admission limit.
- [x] Pi Soul and headless-probe status are evidenced without claiming model execution from CLI help.
- [x] The parity matrix records only measured native behavior and the final baseline decision.

## Non-goals

- Relax the one-live-Pi OAuth admission without upstream evidence.
- Send a billable model prompt to test headless behavior.
- Invent an MCP client where Pi's native extension is the supported Bridge mechanism.

## Open questions

- Whether `--print --offline --mode json` can be used as a meaningful headless capability probe without
  credentials or a model request; inspect local behavior and retain `✗` if it cannot.

# 461 — probe-model-provenance

_Created 2026-07-25._

**Status:** shipped
**Closure:** Probe provenance now records the requested model separately from Claude's structured,
runtime-reported model identities; absent provider evidence remains absent.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npx vitest run test/unit/probeAdapterClaude.test.ts test/unit/probeService.test.ts test/unit/probeStore.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`

## Intent

`probe_agent` already forwards a requested Claude model as `--model`, but neither the requested
model nor the model reported by Claude's structured result is retained in probe provenance. A caller
therefore cannot prove that an adversarial review used the requested model. Record both facts without
claiming a reported model when the runtime does not provide one.

**Affected Product Invariants:** none — this adds probe provenance only.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: requested Claude model is auditable**
  - **Given** a Claude probe requested with model `claude-opus-5`
  - **When** its metadata is written and the run finishes
  - **Then** the metadata records `requestedModel`, and the returned result preserves a runtime-reported
    model only when Claude provides it.
- [x] **Scenario: missing runtime provenance remains honest**
  - **Given** a Claude result with no usable model-usage record
  - **When** it is interpreted and stored
  - **Then** no effective model is fabricated from the requested model.
- [x] Existing invocation behavior remains explicit: requested Claude models reach the CLI as
  `--model <value>`.

## Non-goals

- Guarantee that a provider honors a requested model when its result omits provenance.
- Redesign the Probes table; its display work is tracked separately in `t-3a3de1`.

## Open questions

None. The policy is requested-versus-reported provenance, never inferred effective model identity.

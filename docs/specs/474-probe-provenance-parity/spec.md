# 474 — probe-provenance-parity

_Created 2026-07-26._

**Status:** shipped
**Closure:** Shipped in the t-be9405 worktree: fleet audit of the four provenance obligations (the
**Verify:** `npm run verify:full:quiet`
**Dogfood:** `npm run dogfood -- probe-provenance-parity`
first three already held everywhere), Grok effective-model extraction from its measured `modelUsage`
so Grok leaves SDD 473's unproven exemption, the Codex absence recorded as measured and filed as
`t-a10d31`, and a registry guard that fails any adapter which neither declares
`reportsEffectiveModel` nor carries a reasoned exemption. Evidence: `npm run verify:full:quiet`
(519 files, 5833 tests) and `npm run dogfood -- probe-provenance-parity` (6/6).
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

SDD 473 made a probe refuse to pass off an unproven model as evidence, and left one deliberate
exemption: a runtime that reports no model at all keeps its result but is permanently `unproven`.
That exemption was declared from what the adapters happened to do, not from what the runtimes can
actually emit. If a runtime does publish its effective model and we simply never read it, the
exemption is a bug wearing a contract's clothes.

This spec audits every probe adapter against the four provenance obligations — the requested model
reaches the invocation, `requestedModel` is persisted, an effective model is extracted only from
structured evidence, and absence never becomes inference — and closes the gap wherever real evidence
exists.

Measurement found one: Grok's own result JSON already carries `modelUsage` keyed by the model
identifier, exactly like Claude's. Grok probes have been unprovable purely because nobody read it.

It also found one genuine absence: `codex exec --json` emits no model identity anywhere. That
exemption is real, and this spec records it as measured rather than assumed.

The lasting part is the guard: a new adapter must not be able to join the fleet and be quietly
unprovable. Either it declares it can prove its model, or it is listed as a known exemption with a
reason.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: a Grok probe proves its model**
  - **Given** a Grok probe requested with the model the runtime actually runs
  - **When** its result JSON reports `modelUsage` keyed by that identifier
  - **Then** the identifier is persisted as the effective model and the verdict is `proven`.
- [x] **Scenario: a Grok fallback is caught**
  - **Given** a Grok probe requested with one model
  - **When** its `modelUsage` reports a different identifier
  - **Then** the probe fails as `model_mismatch`, exactly as Claude already does.
- [x] **Scenario: Grok reports nothing**
  - **Given** a Grok probe that returns a result with no `modelUsage`
  - **When** a model was explicitly requested
  - **Then** it fails as `model_unproven` rather than passing silently.
- [x] **Scenario: Codex stays honestly exempt**
  - **Given** a Codex probe with an explicit model
  - **When** it completes
  - **Then** the result is preserved and recorded `unproven`, with no effective model invented from
    cost, tokens, or the requested value.
- [x] Every adapter passes the requested model to its native invocation, covered per adapter.
- [x] A registry-level guard fails if any registered adapter neither declares
  `reportsEffectiveModel` nor appears in an explicit, documented exemption list.
- [x] The accepted evidence shapes are recorded as measured against named CLI versions.
- [x] The read/list surface reports the verdict for every runtime without adding or restyling any
  probe table UI (that work belongs to `t-3a3de1`).

## Non-goals

- Any visual/table work on the Probes surface — `t-3a3de1` owns it; this spec only ensures the data
  is present and correct.
- Making Codex provable by dropping `--ephemeral` and correlating session rollouts, or by asking
  upstream for a model field — filed as `t-a10d31`.
- Inferring an effective model from cost, token counts, latency, or the requested value.
- Changing how any runtime is invoked beyond what the audit proves is missing.
- Publishing a release or touching Marketplace state.

## Open questions

None. The Codex exemption is measured and filed; every other adapter either proves its model or is
guarded against joining silently.

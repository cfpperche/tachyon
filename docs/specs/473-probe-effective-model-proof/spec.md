# 473 — probe-effective-model-proof

_Created 2026-07-26._

**Status:** shipped
**Closure:** Shipped in the t-37fb51 worktree: `ProbeModelProof` verdict computed from the requested
model and the runtime's reported identities, persisted in metadata and carried on the envelope;
`model_mismatch` fails always and `model_unproven` fails a capable runtime; the Claude adapter now
preserves the provider-native `modelUsage` keys; historical runs derive an honest verdict on read
without rewriting artifacts. Evidence: `npm run verify:full:quiet` (518 files, 5818 tests) and
`npm run dogfood -- probe-model-proof` (7/7), which reproduces both recorded incidents.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

A probe requested with an explicit model can silently run on a different one. Three recorded cases:
`probe-66c1e789` and `probe-42744006` both asked for `claude-opus-5` and the transcript's
`modelUsage` proves `claude-haiku-4-5-20251001` actually ran; `probe-77505e6b` asked for
`claude-opus-5`, completed at $0.2126, and recorded no effective model at all.

SDD 461 (`t-b516f4`) made the two facts *storable* — `requestedModel` in the metadata, the runtime's
reported models under `native.reportedModels`. Nothing compares them. So a fallback is persisted as
a clean success, and a reviewer asked to prove "this review ran on Opus 5" cannot: the artifacts
either disagree in a way nobody checks, or say nothing.

This matters because probe results are used as evidence. A review that silently ran on a smaller
model is not the review that was commissioned, and a result that cannot prove which model produced
it must never be readable as if it could.

Done looks like: the requested model, the effective provider-native identifier and an explicit
verdict about whether they agree are persisted and exposed; a proven mismatch fails the probe rather
than reporting success; and a result that cannot be proven says so in the artifact instead of
looking like any other pass.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: a silent fallback fails the probe**
  - **Given** a probe requested with `model: claude-opus-5`
  - **When** the runtime reports it actually ran `claude-haiku-4-5-20251001`
  - **Then** the probe terminates as failed with a model-mismatch reason naming both the requested
    and the effective model, and is not reported as completed.
- [x] **Scenario: an unprovable explicit model does not read as success**
  - **Given** a probe requested with an explicit model on a runtime that does report model usage
  - **When** it finishes cleanly but reports no effective model
  - **Then** it does not terminate as completed, and the artifact records that the model was
    unproven.
- [x] **Scenario: the effective provider-native identifier is persisted**
  - **Given** a Claude probe whose `modelUsage` is keyed by `claude-haiku-4-5-20251001` with
    `canonicalModel: claude-haiku-4-5`
  - **When** the run is stored
  - **Then** both the native identifier and the canonical family are recorded, not just the family.
- [x] **Scenario: a matching model is proven, not merely assumed**
  - **Given** a probe requested with a model the runtime confirms it ran
  - **When** it completes
  - **Then** the artifact records the verdict `proven` and the run completes normally.
- [x] **Scenario: no explicit model is not a failure**
  - **Given** a probe with no requested model
  - **When** it completes
  - **Then** nothing is failed for model reasons and the verdict records that no model was requested.
- [x] **Scenario: a runtime that cannot report is honest rather than silent**
  - **Given** a probe with an explicit model on a runtime that never reports model usage
  - **When** it completes
  - **Then** the result is preserved but explicitly marked unproven, so it cannot be read as proof.
- [x] The verdict and both model fields are readable from the stored result and from the probe
  read/list surface, not only from the metadata file.
- [x] Historical runs stored before this spec are reported as unproven — never retroactively
  presented as proven.
- [x] Whether a runtime can report its effective model is an explicit per-adapter capability, so
  extending enforcement to another runtime is a declaration rather than a rewrite.

## Non-goals

- Inferring the effective model from cost, latency, or output characteristics — only what the
  runtime itself reports counts as proof.
- Adding model reporting to the Codex or Grok adapters (they surface nothing today); this spec makes
  their silence visible, and filing that gap is separate.
- Retrying, re-running, or otherwise "fixing" a mismatched probe — this spec detects and refuses.
- Changing how `--model` is passed to any runtime.
- Publishing a release or touching Marketplace state.

## Open questions

**Resolved by the coordinator (2026-07-26).** An explicit model on a runtime that cannot report does
NOT hard-fail: the result is preserved for compatibility but must persist an unambiguous unproven
verdict, must never have an effective model filled in by inference, and must never be presented as
verified. A proven mismatch fails always; a capable runtime (Claude) with an explicit model and no
evidence fails as `model_unproven`.

**The Codex/Grok exemption is temporary and contractual**, not a permanent carve-out: it exists only
because those adapters surface no model usage today. It is declared per adapter via
`reportsEffectiveModel`, so when either gains reporting, setting that flag turns enforcement on with
no change to the service. Until then their probes are structurally incapable of proving a model and
their results must be read accordingly.

# 473 — probe-effective-model-proof — notes

_Created 2026-07-26._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **The matching rule needed a real fix mid-build, caught by its own test.** The plan claimed a `-`
  boundary was enough to accept `claude-opus-5` ← `claude-opus-5-20260101` while rejecting
  `claude-opus` ← `claude-opus-5`. It is not: `claude-opus-5` is literally `claude-opus` + `-5`, so
  the two cases are structurally identical. The rule now requires the suffix to look like a release
  stamp (six or more digits), which accepts a dated identifier and refuses a version bump. The test
  was written from the intent and failed the first implementation — exactly what it was for.
- **A run that used the requested model AND another one is a mismatch, not a pass.** Every reported
  model must satisfy the request. A partially-correct run is not clean evidence that the requested
  model produced the answer.
- **An already-failed run keeps its own reason.** A timeout that also lacked model evidence is most
  usefully still a timeout; the verdict rides alongside instead of overwriting it.
- **The read path derives a verdict for historical runs from stored evidence only.** It never
  invents proof: a pre-473 artifact with nothing recorded reads as `unproven`, and the stored
  `result.json` is not rewritten. This is the task's "do not alter historical results as if they
  were proven", implemented as derive-on-read rather than backfill-on-disk.

## Decisions taken by the coordinator

- **The Codex/Grok exemption is temporary and contractual.** Confirmed 2026-07-26: a proven mismatch
  fails always; a reporting-capable runtime with an explicit model and no evidence fails as
  `model_unproven`; a runtime that currently cannot report preserves its result for compatibility
  but must persist an unambiguous unproven verdict, must never have an effective model filled in by
  inference, and must never read as verified. Declared per adapter via `reportsEffectiveModel`, so
  enabling enforcement later is a flag flip rather than a service change.

## Deviations

- The plan expected to touch only the probe module; the row also had to be widened through
  `WorkspaceProbeViewRowV1` and its runtime validator in `src/engine-service/protocol.ts`, because
  the probe view crosses the engine wire contract. Preview fixtures and the protocol test row moved
  with it.

## Tradeoffs

- **This can fail probes that previously returned a result.** That is the intent, but it is bounded
  deliberately: enforcement only engages when a model was explicitly requested, so the common
  no-model probe is untouched, and only a reporting-capable runtime can fail for missing evidence.
- The verdict is computed in the service rather than each adapter, so adapters stay reporters of
  fact and the policy lives in one place. The cost is that an adapter cannot express a
  runtime-specific notion of "same model"; no runtime needs one today.

## Open questions

None. The remaining known gap — Codex and Grok reporting no model usage at all — is the coordinator's
documented temporary exemption above, and belongs to those adapters rather than this spec.

## Verification log

<!-- appended by `/sdd verify --run` -->

## Dogfood log

<!-- appended by `/sdd dogfood --run` -->

### 2026-07-26T19:40:35Z — pass (1/1) — source: tasks.md — commit: bd8bac5d864e19749c94147003395a34ba8702e8
- `npm run dogfood -- probe-model-proof` — pass

# 475 — probes-effective-model-column — tasks

_Generated from `plan.md` on 2026-07-26. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add `effectiveModel` to `ProbeRunRecord`, sourced from the run's `reportedNativeModels` with a
      canonical-family fallback for pre-474 Claude runs.
- [x] Derive `model` / `modelState` / `modelTitle` in `buildProbeView` per the four-shape table.
- [x] Carry the three fields through `WorkspaceProbeViewRowV1` and its strict validator.
- [x] Render the column between `runtime` and `archetype`, switching style on `modelState`.
- [x] Style long identifiers to wrap within a bounded width; no horizontal overflow.
- [x] Extend the preview fixtures with a row per state (proven/mismatch/unproven/not-requested/running).
- [x] Add `scripts/dogfood/probes-model-column.ts` and its npm script.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Proven → the effective identifier is shown. (scenario 1)
- [x] Mismatch → effective shown as differing, requested named. (scenario 2)
- [x] Unproven → literal `unproven`, requested identifier never shown in the cell. (scenario 3)
- [x] Not-requested → identifier when reported, `—` when not. (scenario 4)
- [x] Running → no assertion. (scenario 5)
- [x] The effective value comes from the run's stored provenance, not a declared agent model.
- [x] A pre-provenance historical run renders `unproven`/`—`.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run dogfood:probes-model-column`

**Human dogfood:** open Control → Probes after running probes with and without an explicit model and
confirm the model column reads correctly for each, including a mismatch.

## Visual QA

_Real surface inspected, evidence captured, verdict recorded._

Evidence: `docs/specs/475-probes-effective-model-column/evidence/probes-model-column-wide.png`
(1400px) and `evidence/probes-model-column-narrow.png` (860px panel), each showing all five states
in one table — proven, mismatch, unproven, reported and none/running. Captured from the real Probes
surface via the preview harness (`?view=cockpit&fixture=agent-probes`), with a pre-change baseline
captured for comparison.

Verdict: **Three real defects found and fixed by looking, none of which a unit test would have
caught.** (1) The model cell's `16ch` cap forced every identifier to two or three lines and made rows
tall while the table's right side sat empty — widened to `24ch`. (2) The ninth column squeezed
`✓ completed` and `adversarial-review` into wrapping; confirmed against the baseline as caused by
this change, fixed with `nowrap` on those two short closed-vocabulary columns. (3)
`overflow-wrap: anywhere` split words mid-token — `unproven` rendered as `unprove`/`n` at narrow
width — changed to `break-word` so identifiers break at their own hyphens, with the two short states
pinned to `nowrap`. After the fixes: no horizontal overflow at either width, every state visually
distinct (proven green, mismatch red bold, unproven muted italic, reported neutral, none dashed),
and the requested model appears nowhere in the cell.

## Cookbook

**Cookbook-Opt-Out:** no operator surface — one read-only column in an existing table.

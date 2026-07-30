# 473 — probe-effective-model-proof — tasks

_Generated from `plan.md` on 2026-07-26. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add `model_mismatch` and `model_unproven` to the reason taxonomy and its exhaustive list;
      both are `failed`, never `completed`.
- [x] Add the `ProbeModelProof` verdict type and carry it on the envelope/result.
- [x] Add `reportsEffectiveModel` to the adapter capability surface; declare it true for Claude only.
- [x] Make the Claude adapter report native identifiers (`modelUsage` keys) alongside canonical
      families, keeping the existing `reportedModels` shape.
- [x] Compute the verdict in `ProbeService.execute` with the conservative matching rule.
- [x] Persist the verdict + effective models in metadata; expose them on the envelope.
- [x] Enforce: `mismatch` fails always; `unproven` fails an otherwise-ok run only on a
      reporting-capable adapter; an already-failed run keeps its reason.
- [x] Surface the verdict through `probeView` read/list; report pre-473 runs as unproven.
- [x] Add `scripts/dogfood/probe-model-proof.ts` and its npm script.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Requested opus, reported haiku → failed `model_mismatch` naming both. (scenario 1)
- [x] Requested model, capable runtime, nothing reported → not completed, recorded unproven. (2)
- [x] Native identifier and canonical family both persisted. (3)
- [x] Matching model → verdict `proven`, run completes. (4)
- [x] No requested model → verdict `not-requested`, nothing failed. (5)
- [x] Explicit model on a non-reporting runtime → preserved but marked unproven. (6)
- [x] Verdict readable from the stored result and the read/list surface.
- [x] A historical run with no verdict reads as unproven, never proven.
- [x] A dated identifier satisfies a family request; a truncated alias does not.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run dogfood -- probe-model-proof`

**Human dogfood:** run a real `probe_agent` with `model: claude-opus-5`, then read the run's
`metadata.json` and the `read_probe_result` payload and confirm both name the requested model, the
effective native identifier and the verdict.

## Visual QA

**Visual QA Opt-Out:** no rendered UI in this spec — the change surfaces a textual field through the
Bridge probe read/list payload, proven by dogfood transcript and unit assertions.

## Cookbook

**Cookbook-Opt-Out:** no new operator surface — an existing Bridge probe payload gains fields;
behavior and reading are covered by `spec.md` and the human dogfood note above.

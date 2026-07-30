# 474 — probe-provenance-parity — tasks

_Generated from `plan.md` on 2026-07-26. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Extract `modelUsage` keys in the Grok adapter into `native.reportedNativeModels`, recording
      the measured CLI version; no invented canonical family.
- [x] Declare `reportsEffectiveModel: true` on the Grok adapter.
- [x] Record the measured Codex absence in `codex.ts`, pointing at `t-a10d31`.
- [x] Add the registry guard: every adapter declares the capability or has a reasoned exemption.
- [x] Per-adapter tests for the `--model` obligation (claude/codex/grok).
- [x] Grok extraction tests: proven, mismatch, missing `modelUsage`, malformed payload.
- [x] Update `docs/runtimes/parity.md` with the measured per-runtime provenance.
- [x] Add `scripts/dogfood/probe-provenance-parity.ts` and its npm script.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Grok reporting the requested identifier → `proven`. (scenario 1)
- [x] Grok reporting a different identifier → `model_mismatch`. (scenario 2)
- [x] Grok reporting no `modelUsage` + explicit model → `model_unproven`. (scenario 3)
- [x] Codex with an explicit model → preserved, `unproven`, nothing inferred. (scenario 4)
- [x] All three adapters put `--model` in the native invocation.
- [x] The registry guard fails an adapter that neither declares nor is exempted.
- [x] The read/list surface carries the verdict for every runtime; no probe-table UI touched.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run dogfood -- probe-provenance-parity`

**Human dogfood:** run a real `probe_agent` with `runtime: grok` and an explicit `model`, then read
the run's `metadata.json` and `read_probe_result` and confirm the effective identifier and verdict
are present.

## Visual QA

**Visual QA Opt-Out:** no rendered surface changes — the verdict already flows through the SDD 473
read/list payload, and the Probes table UI belongs to `t-3a3de1`.

## Cookbook

**Cookbook-Opt-Out:** no new operator surface — an existing probe payload gains provenance for one
more runtime; behavior is covered by `spec.md` and the human dogfood note.

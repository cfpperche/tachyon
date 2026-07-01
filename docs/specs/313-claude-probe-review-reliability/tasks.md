# 313 — claude-probe-review-reliability — tasks

_Generated from `plan.md` on 2026-07-01. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add Claude-native JSON schemas for `adversarial-review` and `factual-verify`.
- [x] Keep `freeform` Claude probes schema-free.
- [x] Add a larger default timeout for Claude adversarial reviews when `timeoutSec` is omitted.
- [x] Record why low explicit budgets/timeouts are not silently raised.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Unit tests prove Claude structured archetypes include `--json-schema`.
- [x] Unit tests prove freeform does not include `--json-schema`.
- [x] Unit tests prove Claude adversarial review default timeout is larger than the generic default.
- [x] A real Claude probe can review the spec-312 plan without `parse_error`.

**Headless check:** `npm test -- test/unit/probeAdapterClaude.test.ts test/unit/probeBridge.test.ts test/unit/probeArchetypes.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Verify:** `npm test -- test/unit/probeAdapterClaude.test.ts test/unit/probeBridge.test.ts test/unit/probeArchetypes.test.ts`

**Dogfood:** `node scripts/dogfood-claude-probe-review.mjs`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

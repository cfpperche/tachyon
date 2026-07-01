# 308 — probe-timeout-diagnostics — tasks

_Generated from `plan.md` on 2026-06-30. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Raise `ProbeService`'s default subprocess timeout above the Bridge sync cap.
- [x] Keep `timeoutSec` from `probe_agent` authoritative when explicitly supplied.
- [x] Change `ProbeRunner` timeout diagnostics to include artifact/stdout/stderr fallback.
- [x] Synthesize a non-empty timeout diagnostic when the killed process produced no output.
- [x] Add timeout metadata to `native` for run-level failures.
- [x] Record reproduction and smoke evidence in `notes.md`.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Unit test: timeout with only stderr returns non-empty diagnostic containing stderr.
- [x] Unit test: timeout with no output returns synthesized diagnostic containing runtime and timeout.
- [x] Unit test: `probe_agent wait:"sync"` with no explicit `timeoutSec` returns `running` at sync cap instead of killing the run.
- [x] Unit test: explicit short `timeoutSec` still produces `timeout`.
- [x] Live smoke: short Claude `probe_agent` completes.
- [x] Live smoke: short Codex `probe_agent` completes.

**Headless check:** `npm test -- --run test/unit/probeRunner.test.ts test/unit/probeBridge.test.ts test/unit/probeAdapterClaude.test.ts test/unit/probeAdapterCodex.test.ts`
**Verify:** `npm test -- --run test/unit/probeRunner.test.ts test/unit/probeBridge.test.ts test/unit/probeAdapterClaude.test.ts test/unit/probeAdapterCodex.test.ts`
**Verify:** `npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npm test -- --run test/unit/probeSmoke.test.ts`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** run a real `probe_agent` review with `wait:"sync"` and no explicit `timeoutSec`; if it exceeds the sync cap, it should return `running` and remain pollable instead of immediately becoming an empty timeout.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

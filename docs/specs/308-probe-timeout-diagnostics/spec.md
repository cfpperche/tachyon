# 308 — probe-timeout-diagnostics

_Created 2026-06-30._

**Status:** shipped
**Closure:** Shipped local implementation on 2026-06-30. `ProbeService` now uses a 5 minute default subprocess budget so `probe_agent wait:"sync"` can return `{status:"running", runId}` at the 120s sync cap instead of killing the run by default; explicit `timeoutSec` remains authoritative. `ProbeRunner` now returns non-empty timeout/killed diagnostics using artifact/stdout/stderr fallback plus synthesized runtime/timeout/signal metadata. Verification: `/sdd verify` passed (`npm test -- --run test/unit/probeRunner.test.ts test/unit/probeBridge.test.ts test/unit/probeAdapterClaude.test.ts test/unit/probeAdapterCodex.test.ts`, `npm run typecheck`); `/sdd dogfood` passed (`npm test -- --run test/unit/probeSmoke.test.ts`). Commit pending.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npm test -- --run test/unit/probeRunner.test.ts test/unit/probeBridge.test.ts test/unit/probeAdapterClaude.test.ts test/unit/probeAdapterCodex.test.ts`
**Verify:** `npm run typecheck`
**Dogfood:** `npm test -- --run test/unit/probeSmoke.test.ts`

## Intent

`probe_agent` works for short Claude and Codex probes, but real review probes can look broken: the sync call waits around 120s, the process times out at the same boundary, and the final failed envelope can contain `reason:"timeout"` with an empty `lastMessage`. That leaves the caller unable to tell whether the runtime is unavailable, the probe was still thinking, the prompt was too large, or the runner killed it.

Done means long probes have a useful lifecycle and useful diagnostics. A sync probe should hand back a `running` runId before the subprocess default wall-clock limit kills it, unless the caller explicitly requested a shorter timeout. When a probe does time out, the result must include a non-empty diagnostic that names the runtime, timeout, signal/process state, and any captured output available.

## Acceptance criteria

- [x] **Scenario: short Claude probe still works**
  - **Given** the installed Claude CLI is available
  - **When** `probe_agent` runs a short freeform Claude task
  - **Then** it returns `status:"completed"`, `reason:"ok"`, and `lastMessage:"OK"` or equivalent.
- [x] **Scenario: short Codex probe still works**
  - **Given** the installed Codex CLI is available
  - **When** `probe_agent` runs a short freeform Codex task
  - **Then** it returns `status:"completed"`, `reason:"ok"`, and `lastMessage:"OK"` or equivalent.
- [x] **Scenario: sync cap is not the default kill time**
  - **Given** a probe launched with `wait:"sync"` and no explicit `timeoutSec`
  - **When** the subprocess is still running at the sync cap
  - **Then** the tool returns `{status:"running", runId}` and the subprocess remains eligible to finish later.
- [x] **Scenario: timeout has a useful diagnostic**
  - **Given** a probe subprocess is killed by Tachyon's wall-clock timeout before producing a final answer
  - **When** the caller reads the finished result
  - **Then** `result.reason` is `"timeout"` and `result.lastMessage` is non-empty, capped, and includes runtime/timeout/signal plus any captured stdout/stderr/artifact excerpt.
- [x] **Scenario: explicit short timeout is respected**
  - **Given** the caller sets a short `timeoutSec`
  - **When** the subprocess exceeds that explicit timeout
  - **Then** Tachyon reports `reason:"timeout"` rather than silently extending the run.
- [x] The fix is runtime-neutral in `ProbeRunner`/`ProbeService`; adapter-specific changes are only for capture improvements that cannot be expressed generically.


## Non-goals

- This spec does not make every review finish inside 120 seconds.
- This spec does not change probe archetype semantics or the JSON schema expected from `adversarial-review`/`factual-verify`.
- This spec does not replace probes with persistent `spawn_agent` panes.
- This spec does not solve provider rate limits or model overload; it only makes probe lifecycle and diagnostics accurate.

## Open questions

- Should Claude probes switch to `stream-json` for partial-message capture on timeout, or is generic stderr/stdout/artifact diagnostic enough for this fix? Decide after unit-level timeout diagnostics are in place.

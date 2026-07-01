# 308 — probe-timeout-diagnostics — notes

_Created 2026-06-30._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- 2026-06-30: The bug is not total probe unavailability. Short real probes completed for both runtimes:
  - Claude Bridge smoke: `probe_agent runtime=claude archetype=freeform task="Reply with OK only."` returned `status:"completed"`, `reason:"ok"`, `lastMessage:"OK"`.
  - Codex Bridge smoke: `probe_agent runtime=codex archetype=freeform task="Reply with OK only."` returned `status:"completed"`, `reason:"ok"`, `lastMessage:"OK"`.
- 2026-06-30: The failure mode is long-probe lifecycle/diagnostics. Real failed Claude review probes `probe-0f36ffc3-44bd-429a-aee3-752df3f4109f` and `probe-c4566997-936d-456a-960e-cd97516c902a` both ended with `reason:"timeout"` and empty `lastMessage`.
- 2026-06-30: `wait:"sync"` and the subprocess default timeout were both effectively 120s. That made the promised sync-to-async handoff ambiguous at the same boundary where the subprocess could be killed. The default subprocess budget is now 5 minutes; explicit `timeoutSec` is still respected.
- 2026-06-30: Timeout diagnostics are fixed in the runtime-neutral runner: artifact, stdout, stderr, then a synthesized fallback containing runtime, timeout, signal, and exit code. No Claude/Codex adapter semantic change was needed.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- None so far.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Did not switch Claude to `stream-json` in this pass. The current `--output-format json` invocation works for short probes, and the shared runner fix makes timeout failures actionable for both runtimes. Streaming partial capture remains a future enhancement if synthesized diagnostics are not enough.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Should probe UI/tooling surface a hint when a caller explicitly sets `timeoutSec <= sync cap` with `wait:"sync"`? The current behavior is correct but may still surprise callers.

## Verification log

- 2026-06-30: `npm test -- --run test/unit/probeRunner.test.ts test/unit/probeBridge.test.ts test/unit/probeAdapterClaude.test.ts test/unit/probeAdapterCodex.test.ts` passed: 4 files, 31 tests.
- 2026-06-30: `npm run typecheck` passed.
- 2026-06-30: `npm test -- --run test/unit/probe*.test.ts` passed: 10 files, 70 passed, 3 skipped.

## Dogfood log

- 2026-06-30: `npm test -- --run test/unit/probeSmoke.test.ts` passed: 2 capability tests passed, 3 live-cost tests skipped by `PROBE_LIVE_SMOKE` gate.
- 2026-06-30: Real Bridge smoke before implementation confirmed availability: short Claude and Codex `probe_agent` freeform calls both returned `OK`.

### 2026-07-01T01:54:03Z — pass (1/1) — source: tasks.md — commit: d616a8412ba3d08a1a0303f206e4fb6f46b727b7
- `npm test -- --run test/unit/probeSmoke.test.ts` — pass

### 2026-07-01T01:54:03Z — pass (2/2) — source: tasks.md
- `npm test -- --run test/unit/probeRunner.test.ts test/unit/probeBridge.test.ts test/unit/probeAdapterClaude.test.ts test/unit/probeAdapterCodex.test.ts` — pass
- `npm run typecheck` — pass

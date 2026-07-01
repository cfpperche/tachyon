# 308 — probe-timeout-diagnostics — plan

_Drafted from `spec.md` on 2026-06-30. The approach, not the steps (those go in `tasks.md`)._

## Approach

Fix the probe lifecycle at the shared service/runner layer first, because both Claude and Codex use it:

1. Make the subprocess default timeout longer than the Bridge sync cap. The sync cap is a UI/tool responsiveness boundary; the subprocess timeout is the execution budget. They should not be the same default.
2. Keep explicit `timeoutSec` authoritative. If the caller asks for 30s, the subprocess may time out at 30s even though `wait:"sync"` can hold longer.
3. Make timeout diagnostics non-empty in `ProbeRunner`. The diagnostic should prefer result artifact, then stdout, then stderr, and if all are empty synthesize a bounded message with runtime, timeout, signal, and process state.
4. Add tests at three layers: pure runner timeout diagnostics, service default timeout vs sync cap behavior, and live smoke expectations for simple Claude/Codex probes.

Only consider adapter-specific Claude streaming if the generic diagnostic still leaves timeouts opaque. The immediate bug is that Tachyon returns an empty diagnostic and has an ambiguous default timeout boundary.

## Key decisions

- **Separate sync cap from process timeout** — chosen because `wait:"sync"` is supposed to avoid a hung tool call, not kill the probe at the same moment; rejected simply telling callers to use async because the advertised sync contract already promises a `running` handoff.
- **Keep explicit timeout strict** — chosen because callers need a real budget/latency cap; rejected silently extending user-provided `timeoutSec` because that would make cost/time control untrustworthy.
- **Guarantee non-empty timeout diagnostics in the runner** — chosen because every adapter benefits and the failed envelope becomes actionable; rejected only fixing Claude because Codex can also time out before writing its artifact.
- **Do not switch Claude to streaming in the first cut** — chosen because the installed `claude -p --output-format json` path works for short probes and the first bug can be fixed without changing adapter semantics; revisit if diagnostics still lack useful partial output.

## Files touched

- `src/probe/ProbeService.ts` — increase the default subprocess timeout above the Bridge sync cap.
- `src/probe/ProbeRunner.ts` — synthesize/capture non-empty timeout diagnostics and expose timeout metadata in `native`.
- `src/bridge/tools.ts` — keep schema unchanged; add/adjust tests around sync cap vs default timeout if needed.
- `test/unit/probeRunner.test.ts` — assert timeout diagnostics include stderr fallback and synthesized fallback when no output exists.
- `test/unit/probeBridge.test.ts` — assert a sync call returns `running` when the default subprocess budget is longer than the sync cap.
- `test/unit/probeSmoke.test.ts` — keep or extend short live smoke expectations for Claude/Codex when runtimes are available.
- `docs/specs/308-probe-timeout-diagnostics/notes.md` — record reproduction evidence and verification output.

## Risks & unknowns

- A longer default timeout means async probes can run longer after a sync caller receives `running`. That is intended, but the cap must remain bounded.
- Existing tests may assume the default timeout is exactly 120s. Update only tests that encode the old accidental coupling.
- `lastMessage` should stay bounded so a noisy stderr/stdout stream does not flood the MCP response.
- If Claude emits no stdout/stderr until final JSON, synthesized diagnostics still will not explain model internals, but they will prove the runner killed an otherwise silent process.

## Sources consulted

- `src/bridge/tools.ts` — `probe_agent` sync cap and `timeoutSec` schema.
- `src/probe/ProbeService.ts` — default subprocess timeout.
- `src/probe/ProbeRunner.ts` — timeout kill and diagnostic construction.
- `src/probe/adapters/claude.ts` — Claude print-mode adapter; short direct smoke works.
- `src/probe/adapters/codex.ts` — Codex artifact-based adapter; short direct smoke works.
- `.tachyon/probes/probe-0f36ffc3-44bd-429a-aee3-752df3f4109f/result.json` and `probe-c4566997-936d-456a-960e-cd97516c902a/result.json` — real failed Claude reviews with `reason:"timeout"` and empty `lastMessage`.

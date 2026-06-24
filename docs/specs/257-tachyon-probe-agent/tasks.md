# Spec 257 — Tasks (committed work order, derived from `plan.md`)

**UI impact:** ui — a transient probe row + a captured-result inspector, both rendered FROM the run ledger (D9). A UI-touching task is proven by a green project UI test over the changed surface, not a static review.

**Verify:** `npx vitest run test/unit`

> Derived from `plan.md` (D1–D10 + OQ1–OQ6 ratified). Dependency-ordered: work top-to-bottom, check off as completed, and update `plan.md` if a task reveals the plan is wrong. Each task is independently checkable.

## Phase 1 — run model + taxonomy (the spine; D1/D3/D4)

- [x] 1. **`src/probe/taxonomy.ts`** — define the `{ runId, status, result? }` envelope and the `terminationReason` enum (`ok | model_error | refused | budget | timeout | killed_signal | process_error | parse_error | empty_output`), `result` shape (`lastMessage`, nullable `exitCode`, `signal?`, `timedOut`, `costUsd?`, `native`). Pure. `test/unit/probeTaxonomy.test.ts`: each reason constructs distinctly, none collapses. ✅ 7/7 green.
- [ ] 2. **Shared `AgentRun` in `src/agents/AgentManager.ts` + `LifecycleMonitor.ts`** — `kind: pane | probe`, probe reuses runId mint + lifecycle states. Regression-guard the existing pane path (existing `spawn_agent → wait_for_agent → read_output` flow unchanged).

## Phase 2 — engine-managed subprocess runner (D6, OQ3)

- [x] 3. **`src/probe/ProbeRunner.ts`** — spawn the runtime headless (no tmux), enforce timeout, support cancellation, capture from artifact files, classify outcome into the taxonomy. `test/unit/probeRunner.test.ts`: timeout-kill, cancel mid-run, signal kill, empty-output. ✅ 5/5 green (injectable spawn/readFile; run-level timeout/killed_signal owned by the runner, content by the adapter).
- [x] 4. **Restart reaping + concurrency cap** — on Bridge restart, an incomplete run → `failed` + kill the stray pid (parallels tmux reconciliation); a concurrency cap rejects-beyond-cap with a clear status. No auto-retry. Implemented in `ProbeService` (concurrency cap + `reap()`); tested in `probeService.test.ts`. ✅

## Phase 3 — per-runtime headless-capture adapters (D5)

- [x] 5. **`src/probe/adapters/types.ts`** — the `HeadlessCapture` interface (invocation, result/event artifact read, native→taxonomy mapping, capability discovery, compat/version probe). ✅ (ProbeSpec / Invocation / RawOutcome / CapabilityReport / HeadlessCaptureAdapter).
- [x] 6. **`src/probe/adapters/claude.ts`** — print/JSON-result mode; budget cap; map the structured error *result* (budget/refusal) to the taxonomy; read the artifact, not raw stdout; capability/compat/version gate. `test/unit/probeAdapterClaude.test.ts`: native→taxonomy mapping + **golden fixtures for noisy/malformed output** + a live smoke gated on binary availability. ✅ 10/10 (stdout-JSON, budget/refusal/empty/parse_error, noise extraction).
- [x] 7. **`src/probe/adapters/codex.ts`** — `exec` + last-message file + `--json` events; sandbox mapping; same capability/compat/version gates + malformed-output fixtures + live smoke. `test/unit/probeAdapterCodex.test.ts`. ✅ 7/7 (file-artifact read, model_error vs process_error, sandbox mapping).

## Phase 4 — provenance store + the thin Bridge tool (D2/D3/D9, OQ1/OQ2)

- [x] 8. **`src/probe/ProbeStore.ts`** — per-run artifacts under `.tachyon/probes/<runId>/`; bounded retention (time AND count, prune oldest); per-artifact size cap + truncation flag; temp+rename publication; path containment. `test/unit/probeStore.test.ts`.
- [x] 9. **`probe_agent` + `read_probe_result` in `src/bridge/tools.ts`** — façade over the shared run; stable envelope on every call; explicit `wait: sync|async`, 120s sync cap (ceiling ~240s) → `status: running` + `runId`; `read_probe_result(runId, wait?)` polls/blocks + `notify` on done (reuse `Waiters.ts`; lighter brief from `spawnContract.ts`); payload-size discipline (summary inline, large artifacts by path). `test/unit/bridge.test.ts` + `auth.test.ts`: tool count/list, sync, cap-overflow→async.

## Phase 5 — archetypes + caller authorization (D7/D8, OQ4/OQ5/OQ6)

- [x] 10. **`src/probe/archetypes.ts`** — `adversarial-review` (anti-bias framing + `{findings,mostImportant}` schema) + `factual-verify` (anti-fabrication framing + `{claims}` schema), each retaining the prose `lastMessage`; freeform = prose-only escape hatch; non-compliant output → `parse_error`. `test/unit/probeArchetypes.test.ts`: schema-valid vs `parse_error`.
- [x] 11. **Caller authorization + least-privilege defaults** — per-runtime restrictive sandbox default mapped from a neutral least-privilege; cross-runtime caller-authorization / budget-ownership / allowed-runtime / per-probe capability declaration; capability-tied worktree isolation via `WorktreeManager` (read-only = none, write = isolated). Auth/isolation/least-privilege SEAMS in `ProbeService` (AuthorizeFn gate, IsolateFn for write-probes, read-only default sandbox); tested in `probeService.test.ts`. Concrete WorktreeManager + policy wired at task 9/12. ✅

## Phase 6 — observability + wiring (D9, OQ2)

- [ ] 12. **Ledger record + sidebar row + result inspector** — emit probe run records to the ledger (`src/activity/*`); a transient collapsible probe row in the sidebar view-model rendered FROM ledger state; `src/webview/ProbeResultPanel.ts` inspector (mirrors `ActivityPanel`/`HandoffPanel`). Wire `ProbeRunner`/`ProbeStore` through `src/workspace/Workspace.ts` + `notify`. **Green project UI test over the surface.**
- [ ] 13. **`.tachyon/probes/` gitignored** in `src/init/initLogic.ts`; `test/unit/init.test.ts` asserts it.

## Phase 7 — verification

- [ ] 14. **Cross-runtime duet dogfood — a MATRIX, not one happy path.** claude probes codex and vice-versa, asserted across: runtime-available, **no-auth**, **forced timeout**, **forced malformed output**, **forced process crash**, **budget-hit**.
- [ ] 15. **Acceptance sweep** — run `npx vitest run test/unit` green and verify every § Acceptance criterion below holds.

## Acceptance

- [ ] Every `probe_agent` call returns the stable `{ runId, status, result? }` envelope — never a sometimes-result/sometimes-id shape. (D3)
- [ ] **Each failure class is asserted SEPARATELY** — runtime error *result* (budget/refusal) vs process nonzero vs Tachyon timeout-kill vs signal kill vs adapter parse failure vs empty output map to distinct `terminationReason`s; none collapse. (D4)
- [ ] No runtime-shaped field leaks to the neutral layer (e.g. a Claude `subtype` lives only under `native`). (D4)
- [ ] Adapters read Tachyon-owned artifacts and survive **golden-fixture noisy/malformed** stdout/stderr/event streams. (D5)
- [ ] Capability/compat is gated by **live smokes** (gated on binary availability) + recorded binary/adapter/schema versions — not by mocks alone. (D5)
- [ ] The persistent-pane lane is unchanged **including shared-resource regressions** — existing `spawn_agent → wait_for_agent → read_output` flows and existing pipeline examples have regression tests. (D1)
- [ ] A running probe is visible from the ledger; a finished probe's result is inspectable by `runId`; UI failure cannot mask a lifecycle break. (D9)
- [ ] An oversized event stream / last-message cannot overflow the MCP payload (summary inline, artifact by path). (D9)
- [ ] A sync call past the 120s cap returns `status: running` + `runId` (never a hung call or a surprise shape); `read_probe_result` then yields the result. (OQ1)
- [ ] A probe is cancellable mid-run; a Bridge restart marks any incomplete probe `failed` and leaves no stray process; the concurrency cap rejects with a clear status. (OQ3)
- [ ] Archetype output is a valid result schema (or `parse_error` when the model doesn't comply); the read-only default runs with no worktree, a write-capable probe in an isolated worktree. (OQ4, OQ5)
- [ ] Per-run artifacts live gitignored under runtime-state, bounded by the retention cap; nothing captured reaches the committed/public surface. (OQ2)

## Closure

_(to be filled when shipped — capability summary, which decisions held, deferred limits)_

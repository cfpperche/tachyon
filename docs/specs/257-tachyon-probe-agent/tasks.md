# Spec 257 — Tasks (PROVISIONAL — draft; re-cut at plan time)

**UI impact:** ui — a transient probe row + a captured-result inspector, both rendered FROM the run ledger (D9). A UI-touching step is proven by a green project UI test over the changed surface, not a static review.

**Verify:** `npx vitest run test/unit` (extend with run-model + taxonomy + adapter + golden-fixture tests as steps land)

> Provisional decomposition to make the draft concrete — NOT a committed work order. `/plan` re-cuts after the **[CONFIRM]** maintainer calls in D10 (two-runtime scope; duet-first consumer) and the open questions (OQ1–OQ6) are settled.

## Phase 1 — the captured probe primitive (MVP: recovers the duet)

- [ ] **S1 — Shared `AgentRun` model + stable envelope + termination taxonomy.** One internal run resource (`kind: pane | probe`, always mints `runId`); the `{ runId, status, result? }` envelope (D3); the Tachyon-owned `terminationReason` taxonomy + `exitCode?`/`signal?`/`timedOut`/`native` (D4). Pure modules + unit tests. (D1, D3, D4)
- [ ] **S2 — claude adapter (headless capture + native→taxonomy mapping).** Read the result/event artifacts (not raw stdout); map native signalling (incl. the budget error *result*) to D4; capability discovery + compat probe + version recording (D5). Unit + a live smoke + **golden fixtures for malformed/noisy output**. (D5, D6)
- [ ] **S3 — codex adapter (headless capture + native→taxonomy mapping).** `exec` + last-message file + `--json` events; sandbox mapping; same capability/compat/version gates + malformed-output fixtures. (D5, D6)
- [ ] **S4 — `probe_agent` Bridge tool (thin façade) + `read_probe_result`.** Façade over the shared run (D2); explicit `wait: sync|async` within the stable envelope; engine-managed subprocess execution, tmux optional mirror only (D6); payload-size discipline — summary inline, large artifacts by path + truncation flags (D9). (D2, D3, D6, D9, OQ1)
- [ ] **S5 — Archetype briefs + output contracts.** `adversarial-review` (anti-bias framing + findings schema) and `factual-verify` (anti-fabrication framing + claims schema); freeform as escape hatch (D7). Decide the output-contract form (schema vs prose) per OQ5.
- [ ] **S6 — Caller authorization + least-privilege defaults.** Per-runtime restrictive sandbox default; caller-authorization / budget-ownership / allowed-runtime / per-probe capability declaration (D8). The cross-runtime security gate, not an afterthought.
- [ ] **S7 — Run ledger + observability row.** Ledger as source of truth; transient collapsible sidebar row + result inspector RENDERED from ledger state (D9). Green UI test over the surface.
- [ ] **S8 — Cross-runtime duet dogfood (a MATRIX, not one happy path).** claude probes codex and vice-versa; assert across: runtime-available, **no-auth**, **forced timeout**, **forced malformed output**, **forced process crash**, budget-hit. (D10)

## Phase 2 — composition (the product differentiator)

- [ ] **S9 — Pipeline/runbook AI node consumes a probe result.** Expose the captured `result` (machine-consumable per OQ5) as a downstream variable / branch condition. (phase-2 consumer)
- [ ] **S10 — verify/judge on captured results.** `verify_agent` + an LLM-judge path take the structured envelope instead of a pane scrape.

## Acceptance

- [ ] Every `probe_agent` call returns the stable `{ runId, status, result? }` envelope — never a sometimes-result/sometimes-id shape. (D3)
- [ ] **Each failure class is asserted SEPARATELY** — runtime error *result* (budget/refusal) vs process nonzero vs Tachyon timeout-kill vs signal kill vs adapter parse failure vs empty output map to distinct `terminationReason`s; none collapse. (D4)
- [ ] No runtime-shaped field leaks to the neutral layer (e.g. a Claude `subtype` lives only under `native`). (D4)
- [ ] Adapters read Tachyon-owned artifacts and survive **golden-fixture noisy/malformed** stdout/stderr/event streams. (D5)
- [ ] Capability/compat is gated by **live smokes** (gated on binary availability) + recorded binary/adapter/schema versions — not by mocks alone. (D5)
- [ ] The persistent-pane lane is unchanged **including shared-resource regressions** — existing `spawn_agent → wait_for_agent → read_output` flows and existing pipeline examples have regression tests. (D1, D10)
- [ ] A running probe is visible from the ledger; a finished probe's result is inspectable by `runId`; UI failure cannot mask a lifecycle break. (D9)
- [ ] An oversized event stream / last-message cannot overflow the MCP payload (summary inline, artifact by path). (D9)
- [ ] `npx vitest run test/unit` green, incl. new run-model + taxonomy + adapter + fixture tests.

## Closure

_(to be filled when shipped — capability summary, which decisions held, deferred limits)_

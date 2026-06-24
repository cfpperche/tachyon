# Spec 257 — Tasks (PROVISIONAL — draft; re-cut at plan time)

**UI impact:** ui — a transient probe row + a captured-result inspector. A UI-touching step is proven by a green project UI test over the changed surface, not a static review.

**Verify:** `npx vitest run test/unit` (extend with probe-adapter + result-shape unit tests as steps land)

> These steps are a provisional decomposition to make the draft concrete. They are NOT committed work order — `/plan` re-cuts them after the decisions (D1–D8) and open questions (OQ1–OQ8) are pressure-tested with codex and agreed with the maintainer.

## Phase 1 — the captured probe primitive (MVP: recovers the duet)

- [ ] **S1 — Neutral result shape + adapter capability interface.** Define `{ lastMessage, exitCode, isError, resultSubtype, costUsd?, events?, runId }` and a `HeadlessCapture` adapter interface (invocation, final-message read, event-stream read, error-result classification). Pure module + unit tests. (D3, D4)
- [ ] **S2 — claude adapter.** Implement headless capture for claude (print/JSON-result mode, budget cap, error-result surfacing). Pin exact flags against current docs at this step. Unit + a live smoke. (D3, D5, prior-art robustness note)
- [ ] **S3 — codex adapter.** Implement headless capture for codex (`exec`, last-message file, `--json` events, sandbox). Pin exact flags. Unit + a live smoke. (D3, D5)
- [ ] **S4 — `probe_agent` Bridge primitive (bounded-synchronous + async fallback).** Wire the primitive to the adapters; sync up to a cap, async-with-`notify` + a result reader beyond it. (D2, OQ1, OQ3)
- [ ] **S5 — Observability row + result inspector.** Transient collapsible sidebar row while running; inspectable captured result after exit; activity-ledger record. Green UI test over the surface. (D6)
- [ ] **S6 — Cross-runtime duet dogfood.** A claude agent probes codex and vice-versa from inside Tachyon; verify clean capture, error-result surfacing (force a budget hit), and observability. (D8)

## Phase 2 — composition (the product differentiator)

- [ ] **S7 — Pipeline/runbook AI node consumes a probe result.** Expose `lastMessage`/result as a downstream variable/branch condition. (D7, OQ7)
- [ ] **S8 — verify/judge on captured results.** `verify_agent` + an LLM-judge path take structured probe output instead of a pane scrape.

## Acceptance

- [ ] A `probe_agent` call returns a clean structured result (not a pane scrape) for both runtimes.
- [ ] A budget/refusal/timeout comes back as `isError` + `resultSubtype` with the error text in `lastMessage` — never an empty success.
- [ ] The persistent-pane lane (`spawn_agent`) is unchanged.
- [ ] A running probe is visible (transient row); a finished probe's result is inspectable by `runId`.
- [ ] `npx vitest run test/unit` green, incl. new adapter + result-shape tests.

## Closure

_(to be filled when shipped — capability summary, which decisions held, deferred limits)_

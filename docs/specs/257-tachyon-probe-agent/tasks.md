# Spec 257 — Tasks (committed work order, derived from `plan.md`)

**UI impact:** ui — a transient probe row + a captured-result inspector, both rendered FROM the run ledger (D9). A UI-touching task is proven by a green project UI test over the changed surface, not a static review.

**Verify:** `npx vitest run test/unit`

> Derived from `plan.md` (D1–D10 + OQ1–OQ6 ratified). Dependency-ordered: work top-to-bottom, check off as completed, and update `plan.md` if a task reveals the plan is wrong. Each task is independently checkable.

## Phase 1 — run model + taxonomy (the spine; D1/D3/D4)

- [x] 1. **`src/probe/taxonomy.ts`** — define the `{ runId, status, result? }` envelope and the `terminationReason` enum (`ok | model_error | refused | budget | timeout | killed_signal | process_error | parse_error | empty_output`), `result` shape (`lastMessage`, nullable `exitCode`, `signal?`, `timedOut`, `costUsd?`, `native`). Pure. `test/unit/probeTaxonomy.test.ts`: each reason constructs distinctly, none collapses. ✅ 7/7 green.
- [~] 2. **Shared run model** — DEVIATED: a cohesive `ProbeService` IS the probe run engine (own runId/storage/cancel/cap/reap) rather than a literal `kind:` on the pane-centric AgentManager; the pane path is untouched (full suite green = no regression). Rationale + codex #40 in notes.md § deviation.

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

- [x] 12. **Observability — DONE.** Store/ledger spine + `read_probe_result` + `onComplete`→`notify`; an editor-area **Probes inspector** (`ProbeResultPanel`, opened by the `tachyon.openProbes` toolbar button) listing captured runs from a PURE, unit-tested render-model (`probeView.ts` — the extract-from-vscode green test); and a **transient sidebar chip** (`● N probes`, O(1) `ProbeService.active()`, opens the inspector). UI renders FROM the store; the store stays the source of truth (D9).
- [x] 13. **`.tachyon/probes/` gitignored** in `src/init/initLogic.ts`; `test/unit/init.test.ts` asserts it.

## Phase 7 — verification

- [~] 14. **Dogfood — UNIT matrix DONE, LIVE matrix DEFERRED.** The failure-class matrix is covered by golden fixtures (claude/codex adapters: ok/budget/refusal/empty/parse/process_error/noise) + the ProbeService/runner tests (timeout/cancel/reap/cap) + the codex adversarial code review. A LIVE claude↔codex run against a real Bridge is a maintainer verification step (env-dependent). Original:
- [x] 15. **Acceptance sweep** — full suite GREEN: 1389/1389 (no spawn_agent/pipeline regression) + 60 probe tests; typecheck clean. Live-dogfood portion → task 14.

## Acceptance

- [x] Every `probe_agent` call returns the stable `{ runId, status, result? }` envelope — never a sometimes-result/sometimes-id shape. (D3)
- [x] **Each failure class is asserted SEPARATELY** — runtime error *result* (budget/refusal) vs process nonzero vs Tachyon timeout-kill vs signal kill vs adapter parse failure vs empty output map to distinct `terminationReason`s; none collapse. (D4)
- [x] No runtime-shaped field leaks to the neutral layer (e.g. a Claude `subtype` lives only under `native`). (D4)
- [x] Adapters read Tachyon-owned artifacts and survive **golden-fixture noisy/malformed** stdout/stderr/event streams. (D5)
- [~] Capability/compat: recorded binary/adapter/schema versions ✓ (live: `codex-cli 0.142.0`) + golden-fixture mocks ✓ + a MANUAL live duet ✓; an AUTOMATED binary-gated smoke test in the suite is still TODO. (D5)
- [x] The persistent-pane lane is unchanged **including shared-resource regressions** — existing `spawn_agent → wait_for_agent → read_output` flows and existing pipeline examples have regression tests. (D1)
- [x] A running probe is visible from the ledger; a finished probe's result is inspectable by `runId`; UI failure cannot mask a lifecycle break. (D9)
- [x] An oversized event stream / last-message cannot overflow the MCP payload (summary inline, artifact by path). (D9)
- [x] A sync call past the 120s cap returns `status: running` + `runId` (never a hung call or a surprise shape); `read_probe_result` then yields the result. (OQ1)
- [x] A probe is cancellable mid-run; a Bridge restart marks any incomplete probe `failed` and leaves no stray process; the concurrency cap rejects with a clear status. (OQ3)
- [~] Archetype output valid-schema-or-`parse_error` ✓; read-only default = no worktree ✓; a write-capable probe in an isolated worktree is DEFERRED (write probes fail closed in this build — isolation not wired). (OQ4, OQ5)
- [x] Per-run artifacts live gitignored under runtime-state, bounded by the retention cap; nothing captured reaches the committed/public surface. (OQ2)

## Closure

**Status: SHIPPED (incl. observability UI) + twice codex-reviewed + live-validated; released 0.40.0.**
The captured headless A2A probe lane is implemented end-to-end and live: `src/probe/` (taxonomy, runner,
claude+codex adapters, store, archetypes, ProbeService, probeView) → `probe_agent` + `read_probe_result`
Bridge tools → wired in `Workspace.ts`; observability = the `ProbeResultPanel` inspector + a transient
sidebar chip. 64 probe tests + full suite green (1393/1393); typecheck + build clean. TWO adversarial
codex reviews folded — core code (50 findings, `8a4f052`) + UI surface (11 findings, `1a6bd16`). A live
duet was run after install (claude→codex factual-verify; claude→claude adversarial-review): valid
structured results, persistence, `binaryVersion`/`caller` recorded, gitignore, native-quarantine, cost,
and the not-found path all verified live. **Outstanding:** an AUTOMATED binary-gated smoke test in the
suite; the LIVE failure-class matrix (forced timeout/crash/budget); the post-v1 follow-ups below.

**Decisions that held:** D3 stable envelope, D4 Tachyon-owned taxonomy (+ codex #23 hardening: completed
= ok only), D5 capability-probed adapters, D6 engine-managed subprocess, D7 archetypes with anti-bias
built in, D8 caller-auth (write probes fail closed), D9 store/ledger spine + payload truncation, OQ1 sync
cap, OQ2 gitignored bounded-retention, OQ3 cancel/reap/cap, OQ5 machine schemas.

**Deviated:** D1 — a cohesive `ProbeService` instead of a literal `kind:` on AgentManager (notes § deviation).

**Deferred (v1 limits / ratified):** a LIVE cross-runtime FAILURE matrix (task 14 — happy-path duet done live; forced timeout/crash/budget still env-dependent) + an automated binary-gated smoke; write-probe
worktree isolation (refused for now); env allowlist, process-group kill, redaction, per-caller ACL (notes
§ Code review deferred list).

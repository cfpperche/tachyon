# 257 — tachyon-probe-agent — plan

_Drafted from `spec.md` (fully ratified: D1–D10 + OQ1–OQ6) on 2026-06-24. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

Build from the run model + failure taxonomy outward, then adapters, then the Bridge surface, then policy and observability — never UI-first (the probe review made UI-as-proof an explicit anti-pattern, D9). The order mirrors `tasks.md` Phase 1 (S1→S8) and front-loads the parts where implementation actually breaks (D4 taxonomy, D5 adapter divergence, D6 subprocess lifecycle), not the happy path.

1. **Shared run model + stable envelope + taxonomy first (D1/D3/D4).** Introduce a single internal `AgentRun` abstraction with `kind: pane | probe` so the probe lane reuses the pane lane's runId mint, storage, cancellation, and ledger — not a parallel engine. The probe is the bounded/captured kind. Define the `{ runId, status, result? }` envelope and the Tachyon-owned `terminationReason` taxonomy as pure, well-tested modules before any process runs. This is the spine; everything else populates it.

2. **Engine-managed subprocess runner (D6).** A probe runs as an engine-managed child process (timeout, cancel, capture from the runtime's own artifact files), NOT headless-inside-a-tmux-pane. tmux may optionally mirror a running probe for live inspection but is never the substrate. Orphan reaping on Bridge restart parallels the existing tmux pane reconciliation (an incomplete run → `failed` + kill the stray pid).

3. **Per-runtime headless-capture adapters (D5).** Two adapters (claude, codex) that own the non-interactive invocation, read the Tachyon-owned result/event artifacts (never raw stdout — it carries login/update/MCP-startup noise), map native signalling into the D4 taxonomy, and gate themselves with capability discovery + a compatibility check + recorded binary/adapter/schema versions. Reuse the per-runtime knowledge already in `src/resume/adapters.ts` and the claude output handling in `src/activity/claudeNormalizer.ts`.

4. **The thin `probe_agent` Bridge tool + `read_probe_result` (D2/D3/OQ1).** A façade over the shared run: explicit `wait: sync|async`, a 120s sync cap (ceiling ~240s) overflowing into `status: running` + `runId`, `read_probe_result(runId, wait?)` polling/blocking with a `notify` on completion. Reuse `src/bridge/Waiters.ts` for the async wait and the brief shape from `src/bridge/spawnContract.ts`.

5. **Archetypes + caller authorization (D7/D8).** Archetype briefs carry framing + a machine output schema (`adversarial-review` = anti-bias + findings schema; `factual-verify` = anti-fabrication + claims schema); freeform is a prose-only escape hatch; non-compliant model output → `parse_error`. Least-privilege per-runtime sandbox default + the cross-runtime caller-authorization/budget-ownership check (a probe lets one agent spend another runtime's budget — a real attack surface).

6. **Provenance store + ledger-backed observability (D9/OQ2).** Per-run artifacts under `.tachyon/probes/<runId>/` (gitignored), bounded retention (time + count), per-artifact size caps with truncation flags — reuse the content-addressed temp+rename discipline from `src/activity/logStore.ts`. Only then the transient sidebar row + result inspector, rendered FROM ledger state.

## Files to touch

**Create:**

- `src/probe/taxonomy.ts` — the `terminationReason` enum (`ok | model_error | refused | budget | timeout | killed_signal | process_error | parse_error | empty_output`), the `{ runId, status, result? }` envelope types, and `result` shape (`lastMessage`, nullable `exitCode`, `signal?`, `timedOut`, `costUsd?`, `native`). Pure, no I/O.
- `src/probe/ProbeRunner.ts` — engine-managed subprocess execution: spawn the runtime headless, enforce timeout, support cancellation, reap on restart, capture from artifact files, classify outcome into the taxonomy. Tmux-free.
- `src/probe/adapters/types.ts` — the `HeadlessCapture` adapter interface (invocation, result/event artifact read, native→taxonomy mapping, capability discovery, compat/version probe).
- `src/probe/adapters/claude.ts` — claude print/JSON-result mode; budget cap; map the structured error *result* (budget/refusal) to the taxonomy; reuse `activity/claudeNormalizer.ts` knowledge.
- `src/probe/adapters/codex.ts` — codex `exec` + last-message file + `--json` events; sandbox mapping; native→taxonomy mapping.
- `src/probe/archetypes.ts` — `adversarial-review` + `factual-verify` briefs (framing + output schema) and the freeform escape hatch.
- `src/probe/ProbeStore.ts` — per-run artifact store under `.tachyon/probes/<runId>/`, bounded retention (time + count), size caps + truncation flags, temp+rename publication, path-containment (never outside the probe root).
- `src/webview/ProbeResultPanel.ts` (+ a minimal webview entry if needed) — the captured-result inspector, rendered from ledger/store state (mirrors `ActivityPanel.ts`/`HandoffPanel.ts`).
- `test/unit/probeTaxonomy.test.ts` — envelope + each `terminationReason` mapped distinctly (no collapse).
- `test/unit/probeRunner.test.ts` — timeout-kill, cancel, orphan-reap-on-restart, concurrency cap, signal kill.
- `test/unit/probeAdapterClaude.test.ts`, `test/unit/probeAdapterCodex.test.ts` — native→taxonomy mapping + **golden fixtures for noisy/malformed stdout/stderr/event streams** + a live smoke gated on binary availability.
- `test/unit/probeStore.test.ts` — retention bound, size cap/truncation, temp+rename, path containment.
- `test/unit/probeArchetypes.test.ts` — schema-valid output vs `parse_error` on non-compliance.

**Modify:**

- `src/agents/AgentManager.ts` + `src/agents/LifecycleMonitor.ts` — introduce the shared `AgentRun` abstraction (`kind: pane | probe`); the probe run reuses runId mint + lifecycle states; **regression-guard the existing pane path** (D1/acceptance).
- `src/bridge/tools.ts` — register `probe_agent` + `read_probe_result`; explicit `wait`; reuse `Waiters.ts` for the async wait; a lighter brief contract (shape from `spawnContract.ts`).
- `src/bridge/Waiters.ts` — extend the waiter registry for probe completion if the existing shape doesn't cover it.
- `src/bridge/spawnContract.ts` — derive/reuse a lighter probe brief (task/context/constraints + output contract) without the full spawn delegation contract.
- `src/workspace/Workspace.ts` — construct + pass the `ProbeRunner`/`ProbeStore` through to the Bridge; wire `notify` (`src/workspace/notify.ts`) for async completion.
- `src/worktree/WorktreeManager.ts` — capability-tied isolation (OQ4): the read-only default needs no worktree; a write-capable probe gets an isolated worktree by default.
- `src/activity/logWriter.ts` / `logStore.ts` — emit probe run records into the ledger (the observability source of truth) if probes share the activity ledger rather than a separate store.
- `src/webview/SidebarPrototype.ts` + `src/sidebar/types.ts` + `src/webview/sidebar/App.tsx` — a transient, collapsible probe row in the view-model, rendered from ledger state (summary-only; the result lives in the inspector).
- `src/init/initLogic.ts` — gitignore `.tachyon/probes/` (machine-local), like `.tachyon/pins/`.
- `esbuild.mjs` + `tsconfig.webview.json` — add the probe-result webview bundle if a new entry is introduced.
- `package.json` — register the result-inspector command/panel; no new runtime dependency expected (subprocess + node built-ins).
- `test/unit/bridge.test.ts` + `test/unit/auth.test.ts` — tool-count/list expectations + `probe_agent`/`read_probe_result` behavior (sync, cap-overflow→async, auth gate).
- `test/unit/init.test.ts` — assert `.tachyon/probes/` is ignored.

**Delete:**

- None. Resume/`probe_session`, redaction, per-caller ACL, full queueing, and a Tachyon process-enforcement layer are deferred by **absence** (no module, flag, or surface added in v1) — see spec § Non-goals.

## Alternatives considered

### A `mode: probe` flag on `spawn_agent` instead of a distinct tool

Rejected (D2): the return contract genuinely differs — `spawn_agent` returns "started", a probe returns a result envelope. A single tool that sometimes blocks and returns a different shape is a worse API than two clear tools over one shared internal run. We unify the *internals* (`AgentRun`), not the *surface*.

### Run the probe headless inside a tmux pane (the existing substrate)

Rejected (D6): a non-interactive command inside a pane still inherits tmux's TTY detection, buffering, color, signal-propagation, and exit-handling quirks while the pane is not the source of truth. Engine-managed subprocess + artifact-file capture is cleaner; tmux stays an optional debug mirror.

### A Claude-shaped `resultSubtype` at the neutral layer

Rejected (D4): a cross-runtime contract cannot depend on every CLI exposing a Claude-equivalent `subtype`. Tachyon owns a normalized `terminationReason`; runtime-specific fields live under `native`.

### One-runtime MVP to de-risk

Rejected (D10): the cross-runtime duet IS the thesis — a single-runtime MVP proves capture mechanics but not the value. We keep both adapters and instead defer UI/budget polish.

### Auto-retry failed probes

Rejected (OQ3): a probe is a side-effecting, budget-spending model call; auto-retry risks double spend. The caller re-issues. Idempotency/dedup is deferred, not silently assumed.

## Risks and unknowns

- Forcing a CLI to emit schema-valid JSON per archetype is unreliable in practice; the `parse_error` path and a lenient-extraction fallback must be robust, not an afterthought.
- A runtime's headless mode may not cleanly separate an error *result* from a process crash; the native→taxonomy mapping needs live verification + the golden fixtures, not doc-reading alone (D5).
- Engine-managed subprocess lifecycle across a Bridge restart (orphan reaping) is a new path; it parallels tmux reconciliation but does not reuse it.
- Large event streams vs MCP payload ceilings: the summary-inline / artifact-by-path split (D9) must be enforced at the Bridge boundary or a probe can take down the Bridge.
- The capability/compat probe adds startup cost and a versioning surface that drifts on CLI upgrades; recorded versions must invalidate cleanly.
- The cross-runtime caller-authorization model (D8) is new — budget-ownership and allowed-runtime semantics need concrete definition during S6.
- Stdout noise (login/update/MCP-startup/node warnings) can pollute capture even when the artifact file is clean; adapters must read the artifact, not the channel.

## Research / citations

- `docs/specs/257-tachyon-probe-agent/{spec,tasks,notes}.md` — ratified decisions D1–D10 + OQ1–OQ6, and the probe adjudication that reshaped them.
- Probe run (external to this repo): `~/Agent0/.agent0/.runtime-state/codex-exec/20260624T185330Z-…/last-message.md` — the 24 adversarial findings.
- `src/bridge/tools.ts`, `src/bridge/Waiters.ts`, `src/bridge/spawnContract.ts` — tool registration, the event-driven waiter (async-wait precedent), and the delegation-contract shape.
- `src/agents/AgentManager.ts`, `src/agents/LifecycleMonitor.ts` — the agent run lifecycle the shared `AgentRun` extends.
- `src/activity/logStore.ts`, `logWriter.ts`, `claudeNormalizer.ts`, `tailReader.ts` — the ledger + content-addressed temp+rename precedent + existing claude output normalization.
- `src/resume/adapters.ts`, `resolvers.ts` — per-runtime session knowledge (where headless artifacts/transcripts live).
- `src/worktree/WorktreeManager.ts` — isolation for write-capable probes (OQ4).
- `src/workspace/Workspace.ts`, `src/workspace/notify.ts` — store wiring + the notify path for async completion.
- `src/init/initLogic.ts` — `.tachyon/` gitignore policy (add `.tachyon/probes/`).
- `src/webview/ActivityPanel.ts`, `HandoffPanel.ts` — editor-area webview CSP/`localResourceRoots`/message-handling examples for the result inspector.
- claude headless (`-p` / output-format) + codex `exec` docs — pin exact flags at S2/S3 implementation time (do not freeze here; capability-probe instead).

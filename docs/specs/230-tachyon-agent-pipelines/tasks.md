# 230 — tachyon-agent-pipelines — tasks

**Verify:** `npm run typecheck && npx vitest run` (safe with `$TMUX` set — spec 218 guard)

## Design — REVIEWED (codex 2026-06-17 → CHANGES, all folded into spec.md)
- [x] codex adversarial design review of `spec.md` → CHANGES (2 BLOCKER + 3 MAJOR + 1 MINOR).
- [x] **done-contract** revised → `signal_then_verify` (agent default), `exit`/`exit_then_verify`
      (commands), `signal` (no-verify nodes); `timeout` per node; fail-closed; verify accepts only
      `{passed:true, stale:false}`; on-demand BLOCKING verify owned by the pipeline (214 is advisory).
- [x] **worktree** → run-scoped allocation + spawn-cwd override (B2); parallel read-only in MVP;
      writable fan-out + merge → Phase 2 (fork doesn't carry dirty work).
- [x] **failure/retry** → downstream visibly blocked; no auto-retry; retry-node PREFLIGHTS worktree +
      upstream; durability has a SINGLE owner (suppress generic autostart/resume for pipeline nodes).
- [x] **`complete_node`** → per-node nonce/capability + runId/nodeId + live-session + dup/stale reject.
- [x] Maintainer sign-off on the revised design → proceed to `plan`.
- [x] `plan.md` written — build sequence grounded in real seams (`resolveSpawnCwd` for the cwd
      override, `runVerify`+`verifyStale` for the blocking gate, `BridgeDeps`/`registerTool` for
      `complete_node`); Step 0 = the run-scoped-worktree spike (de-risk B2 first).

## Phase 1 — MVP (build after sign-off)
- [x] 0. **SPIKE (de-risk first) — DONE, B2 cleared.** Proved against real git
      (`test/unit/pipeline-worktree-spike.test.ts`, 4/4 + typecheck green): a run allocates ONE worktree
      under a synthetic NAME_RE-safe key `run-<id>` via the stock `WorktreeManager.ensure()`; sequential
      nodes reuse the SAME checkout (`created:false`) and a file written by node A is visible to node B
      (worktree-as-state hand-off works); distinct runs are isolated; the cwd override is expressible in
      front of the existing `resolveWorktreeCwd` (Mechanism B). **No AgentManager change needed** — the
      run worktree is a normal `ensure()` and the override rides the existing `resolveSpawnCwd` seam.
      NAME_RE finding: the key must start with a letter, so `run-<id>` (not `__run_<id>`). See notes.md.
- [x] 1. **Pipeline definition + loader — DONE.** `src/pipeline/loadPipeline.ts` (pure, fail-closed,
      loadConfig-style `{pipeline?, errors}`): parses `.tachyon/pipelines/<name>.yml`; validates name,
      worktree (`own` only v1), nodes (exactly one of agent/cmd, known-agent refs, task, `done` enum with
      agent↔signal / cmd↔exit consistency, `gate` enum, `timeout` duration), self-dep, unknown refs, and
      a DFS cycle check. `test/unit/loadPipeline.test.ts` 22/22; full suite 606 green; typecheck clean.
      Schema block for `tachyon.schema.json` deferred to the wiring step (loader is the source of truth).
- [~] 2. **One-shot node + done-contract** — PURE CORE DONE; spawn/verify wiring is in the executor
      (Step 4). `src/pipeline/doneContract.ts` (`evaluateDone(done, signals)` → done/failed/pending+
      waitingFor; fail-closed on exit-without-signal + timeout; verify accepted only `passed && !stale`;
      idle never an input) + `src/pipeline/runState.ts` (immutable state machine: initRun/runnable/
      start/complete/approve/fail+downstream-block/reject/runStatus; gate:approve → awaiting-approval).
      `doneContract.test.ts` 15/15 + `runState.test.ts` 7/7 (incl. diamond fan-in + failure cascade);
      full suite 628 green; typecheck clean.
- [ ] 3. **Authenticated `complete_node` Bridge tool** — per-node nonce injected into the node agent's
      env; validates runId/nodeId/nonce + live session; rejects duplicates + stale runs (codex M1).
- [ ] 4. **Edges + gates** — dependency ordering + fan-in (wait-for-all); gate predicates
      `exit:0 | verify | approve`; fail-closed `blocked` downstream with the upstream reason.
- [ ] 5. **Worktree flow** — the run-scoped worktree (item 0) flows down the chain, torn down on
      completion/dismiss; parallel nodes read-only in MVP.
- [ ] 6. **Run ledger + durability (single owner)** — `.tachyon/runs/<id>.json` (per-node status);
      resume re-enters the first incomplete node; suppress generic autostart/resume for pipeline-owned
      nodes + reconcile state before re-entry (M2); retry-node preflights worktree + upstream (M3).
- [ ] 7. **Human gate** — `gate: approve` → run `awaiting-approval`; Approve/Reject action in the
      sidebar; resume continues, reject fails the run.
- [ ] 8. **Sidebar first-class run** — run as a tree node + per-node child states; controls
      ▶ start / ⏹ cancel / ↻ retry-node.
- [ ] 9. **Docs** — README "Agent Pipelines" section + an example `.tachyon/pipelines/feature.yml`.
- [ ] 10. **Tests (CI: `test/unit/**`)** — loader/DAG-validation (acyclic, bad refs); done-contract
      branches incl. stale-diff + timeout + exit-without-signal; `complete_node` auth (nonce/dup/stale);
      gate predicates + fail-closed blocking; run-ledger resume + autostart suppression; retry preflight;
      sidebar contextValue/run-controls round-trip (logic in PURE modules per vscode-layer-escapes-CI).

## Phase 2 — fast-follow (after MVP proves value)
- [ ] 11. **Pipeline templates** — reusable parameterized pipeline definitions (feature / bugfix);
      seed via `Tachyon: New Pipeline`.
- [ ] 12. **Studio visualization** — pipeline graph + live run state + step traces from the run ledger
      (XYFlow-style), inside the existing Agent Studio webview; authoring stays YAML.
- [ ] 13. **Sensors (dev-scoped)** — discrete dev-event triggers that START a pipeline (file/glob
      change, git push / PR open, command done); NOT cron/continuous.

## Acceptance
- [ ] A two-node pipeline (`implement` → `review`) runs end-to-end on a real task: worktree flows,
      `done: verify` gates the hand-off, `gate: approve` pauses for a human, run completes.
- [ ] Killing + reopening VS Code mid-run resumes at the first incomplete node (durability proven).
- [ ] A failed node holds its downstream visibly `blocked` (no silent wedge, no auto-retry).
- [ ] `npm run typecheck && npx vitest run` green.

**Closure:** _(unset — fill on ship)_

# 230 — tachyon-agent-pipelines — plan

_Created 2026-06-17. Implements the codex-reviewed design in `spec.md` (CHANGES folded). Phase 1 only;
Phase 2 (templates / Studio-visualization / sensors) is planned at the end of Phase 1._

## Guiding constraints (from the design + the review)
- **One-shot only.** A node completes on a real signal (`signal_then_verify` / `exit` / `signal`),
  never on interactive-idle. Every node has a `timeout` and fails closed.
- **Worktree is the state.** A pipeline RUN owns one worktree; nodes run in it in sequence.
- **Reuse existing seams, don't refactor the agent model.** The review's two BLOCKERs are both
  addressable through hooks that already exist — no rewrite of how agents own worktrees/sessions.
- **Logic in pure modules** (the vscode-layer-escapes-CI rule): the loader, DAG validation, the run
  state machine, the done-contract evaluator, and the contextValue builder all live in plain TS modules
  under `src/pipeline/` with unit tests; `Workspace`/`Sidebar`/`extension.ts` stay thin wiring.

## Seams in the current code (verified 2026-06-17)
- **`AgentManager.resolveSpawnCwd(ctx: SpawnCwdContext)` (spec 210)** returns `{cwd, worktree?}` and is
  owned by `Workspace` — *this is the spawn-cwd override the review (B2) asked for.* A pipeline node's
  spawn resolves its cwd to the RUN's worktree instead of the agent-keyed checkout.
- **`WorktreeManager.pathFor(base, wsHash, agent)` = `<base>/<wsHash>/<agent>`**, `ensure()` keyed by
  that path (`WorktreeManager.ts:71,302`). Run-scoped allocation = call `ensure()` with a **synthetic
  key** `run-<runId>` (NAME_RE requires a leading letter — spike finding) → one worktree per run, not
  per agent. Minimal change.
- **`Workspace.runVerify(agent)` (`Workspace.ts:643`)** already runs the declared verify gate in the
  worktree and returns `VerifyState`; **`verifyStale(state, headRef, dirty)` (`verify.ts:48`)** already
  computes staleness. The pipeline's on-demand BLOCKING verify = call `runVerify` on the run worktree
  and accept iff `state.passed && !verifyStale(...)`. (The 214 sidebar badge stays advisory; the
  pipeline owns its own blocking call — distinct paths.)
- **Bridge tools = `mcp.registerTool(name, {inputSchema}, handler)` + `BridgeDeps` callbacks**
  (`tools.ts:119`, e.g. `runVerify` at `:41`). `complete_node` is a new tool + a `deps.completeNode`
  callback. Tools identify the agent by a `name` arg, not by auth → the nonce check is mandatory (M1).
- **Session durability** lives in `SessionLedger` (`.tachyon/sessions.json`) + `planResume`
  (`planResume.ts:35`) + autostart at activation (`Workspace.ts:851`). Pipeline runs get a SEPARATE
  ledger (`.tachyon/runs/<id>.json`) and the run becomes the single owner of its nodes' sessions (M2).

## Phase 1 — build sequence

### Step 0 — SPIKE: run-scoped worktree + spawn-cwd override (de-risk first; codex B2)
Prove, with a throwaway test + a manual run, that:
- `WorktreeManager.ensure({agent: "run-<id>", baseBranch})` allocates one worktree at a run-scoped
  path and `remove()` tears it down.
- A node agent spawned through `resolveSpawnCwd` lands in that cwd (tmux pane born there), NOT in
  `<base>/<wsHash>/<nodeAgent>`, and its ledger row reflects the run worktree.
- Two sequential nodes in the same run see each other's on-disk changes.
**Exit criterion:** a 2-node hand-off shares one worktree. If `resolveSpawnCwd` can't express this
without touching `AgentManager` internals, surface it here before building the rest.

### Step 1 — config: loader + schema + DAG validation (pure)
- `src/pipeline/loadPipeline.ts` — parse `.tachyon/pipelines/<name>.yml` → `PipelineDef`
  (`{name, worktree, nodes: Record<id, NodeDef>}`); `NodeDef = {agent?|cmd?, task, needs?, done, gate?,
  timeout}`.
- `validatePipeline()` — acyclic (reject cycle/self-dep), refs resolve to known agents (cross-check the
  loaded `tachyon.yml` agents) or a command, exactly one of `agent`/`cmd`, `done`∈enum, `timeout`
  parses. Pure; mirrors `loadConfig`'s fail-closed style. Add a `tachyon.schema.json` block + a
  `pipelines.schema.json` (or inline) for editor validation.

### Step 2 — run state machine + done-contract evaluator (pure)
- `src/pipeline/runState.ts` — `PipelineRun` = `{id, pipeline, worktreeKey, nodes: Record<id,
  NodeState>}`; `NodeState.status ∈ pending|running|blocked|done|failed|awaiting-approval`. Pure
  transitions: `runnable(run)` (deps done + gate satisfiable), `onDone/onFail/onTimeout`,
  `block-downstream(reason)`.
- `src/pipeline/doneContract.ts` — given a node + signals (`exitCode?`, `signalled?`, `verify?:
  {passed, stale}`), decide done/failed: `signal_then_verify` needs `signalled && verify.passed &&
  !verify.stale`; `exit` needs `exitCode===0`; `exit_then_verify` both; `signal` needs `signalled`.
  Timeout/`exit-without-required-signal` → failed. Pure + exhaustively unit-tested.

### Step 3 — authenticated `complete_node` Bridge tool (codex M1)
- At node spawn, inject `TACHYON_RUN_ID`, `TACHYON_NODE_ID`, `TACHYON_NODE_NONCE` into the node agent's
  env (reuse the env-injection path `applyHarness`/spawn env uses).
- New tool `complete_node` (`tools.ts`): `inputSchema {runId, nodeId, nonce}`; `deps.completeNode`
  validates nonce match + node is `running` + session live + **rejects duplicates and stale/closed
  runs**; on success marks the node `signalled` (→ triggers the done-contract / verify run).

### Step 4 — the run executor (Workspace-wired)
- `src/pipeline/PipelineManager.ts` (thin orchestrator, pure-ish; side effects via injected deps mirror
  `AgentManager`): on `start`, allocate the run worktree (Step 0), seed the run ledger, then drive the
  loop — for each `runnable` node: spawn its agent/command (cwd = run worktree via `resolveSpawnCwd`),
  arm the `timeout`, await its done signal (process exit for `cmd`; `complete_node` for agents) → run
  the blocking verify when the contract needs it → transition. Fan-in waits for all upstream.
  Fail-closed blocks downstream with the upstream reason. Persist the run ledger on every transition.

### Step 5 — durability: single owner + resume (codex M2) + lifecycle wiring (codex S4 M5)
- Run ledger `.tachyon/runs/<id>.json`; on activation, `PipelineManager` reconciles each node's
  live/dead/resumable state (via the existing resume resolvers) BEFORE re-entering, and re-enters the
  first incomplete node.
- **Suppress generic autostart/resume for pipeline-owned node sessions — needs a TYPED persisted field,
  not an untyped tag (codex S4 M4).** `SessionDef` has no pipeline-owner field and `parseDef()` drops
  unknown keys (`SessionLedger.ts:23,183`), so a bare `def.pipelineRun` would NOT survive a reload. Add
  a typed `pipeline?: { runId: string; nodeId: string }` to `SessionDef`, preserve it through
  normalize/record, and make BOTH `planResume()` (`planResume.ts:35`) and `autostartPending()` skip rows
  that carry it (activation runs the resume plan before autostart — `Workspace.ts:864`). With tests.
- **Wire the node lifecycle into the executor (codex S4 M5).** Today `Workspace`'s lifecycle callbacks
  (`onKilled` ~`Workspace.ts:345`, session-end ~`:362`) only notify waiters/UI. Map an agent session
  name back to its `{runId, nodeId}` and call `PipelineManager.onProcessExit` (cmd nodes) /
  `onSessionEnd` (agent nodes) so a node that exits without `complete_node` fails promptly instead of
  only timing out.
- **Retry-node preflights** (codex M3): worktree exists / right branch / clean-enough / upstream nodes
  still `done`; else require an explicit reset or a new run.

### Step 6 — human gate
- `gate: approve` → node enters `awaiting-approval`, run pauses; Approve resumes the loop, Reject fails
  the run. Surfaced as a sidebar inline action (Step 7).

### Step 7 — sidebar (pure contextValue + thin TreeItem)
- `src/pipeline/pipelineContextValue.ts` (pure, round-trip tested per the CI-escape rule) — a run is a
  top-level tree node; nodes are children with per-status icons; run controls ▶ start / ⏹ cancel /
  ↻ retry-node + Approve/Reject on `awaiting-approval`. Guard the package.json menu `when` regexes
  against the builder (the spec-0.21.3 menu-contract-guard pattern).

### Step 8 — docs
- README "Agent Pipelines" section + a committed example `.tachyon/pipelines/feature.yml`.

### Step 9 — tests (CI `test/unit/**`)
- Pure: loader/DAG-validation; done-contract (all branches incl. stale-diff, timeout,
  exit-without-signal); run state transitions + downstream-blocking; contextValue round-trip + menu
  guard. Wiring: `complete_node` auth (nonce/dup/stale); run-ledger resume + autostart suppression;
  retry preflight. A real-tmux integration test (xvfb, local gate) for the 2-node hand-off if feasible.

## New module layout
```
src/pipeline/
  loadPipeline.ts        # parse + validate (pure)
  runState.ts            # run/node state machine (pure)
  doneContract.ts        # completion evaluator (pure)
  pipelineContextValue.ts# sidebar contextValue builder/parser (pure)
  PipelineManager.ts     # executor — side effects via injected deps (Workspace-wired)
```
Wiring edits: `bridge/tools.ts` (+`complete_node`), `bridge/Bridge.ts`/`BridgeDeps` (+`completeNode`),
`workspace/Workspace.ts` (allocate run worktree via `resolveSpawnCwd`; own `runVerify` for the gate;
autostart suppression), `config/tachyon.schema.json`, `presentation/Sidebar.ts` + `extension.ts`
(commands/menus), `package.json`/nls + pt-BR l10n.

## Risks & mitigations
- **R1 — run-scoped worktree doesn't fit `resolveSpawnCwd` cleanly** (the B2 risk). *Mitigation:* Step 0
  spike is the gate; if it needs an `AgentManager` change, scope that change before building Steps 1-9.
- **R2 — an agent calls `complete_node` but the work isn't actually done** (false signal). *Mitigation:*
  `signal_then_verify` default — the verify gate is the real arbiter; bare `signal` is opt-in for
  no-code nodes.
- **R3 — verify is green on a stale/empty diff.** *Mitigation:* `verifyStale()` already exists; accept
  only `passed && !stale`.
- **R4 — pipeline node sessions double-resumed by activation.** *Mitigation:* Step 5 ownership tag +
  autostart suppression, with a unit test asserting `planResume` skips tagged rows.
- **R5 — scope creep toward a continuous engine.** *Mitigation:* the Non-goals in `spec.md`; sensors
  stay Phase 2 and dev-event-discrete.

## Phase 2 (plan after Phase 1 ships)
9. Pipeline templates (parameterized defs + `Tachyon: New Pipeline`).
10. Studio visualization (graph + live run state + traces from the run ledger, inside Agent Studio;
    authoring stays YAML).
11. Dev-scoped sensors (file/glob change, git push/PR-open, command-done) that START a pipeline.

## Decision gate
Proceed to implementation starting at **Step 0 (spike)**. If the spike fails its exit criterion, return
here to scope an `AgentManager` change before continuing. Otherwise build Steps 1-9 in order; codex
dueto review at implementation close (per the Tachyon ship discipline).

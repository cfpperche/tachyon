# 230 — tachyon-agent-pipelines — notes

## Step 0 spike — run-scoped worktree + cwd override (2026-06-18) → B2 CLEARED

**Goal:** de-risk codex BLOCKER B2 (worktrees are agent-keyed today; the pipeline needs a run-owned
worktree) before building anything else.

**Result — addressable with NO `AgentManager` change.** Proof: `test/unit/pipeline-worktree-spike.test.ts`
(real git, tmp repo, 4/4 + `npm run typecheck` green).

Findings:
1. **Run-scoped allocation is a normal `ensure()`.** `WorktreeManager.ensure({agent:"run-<id>", branch})`
   creates one worktree at `<base>/<wsHash>/run-<id>` — the synthetic key just occupies the `agent`
   path segment. No new path scheme.
2. **Sequential nodes share the checkout.** A second `ensure()` with the same run key returns
   `created:false` and the identical path; a file written by node A is read back by node B in that
   worktree → **worktree-as-state hand-off works**.
3. **Runs are isolated** — distinct `run-<id>` keys → distinct worktrees.
4. **The cwd override rides the existing seam.** `resolveSpawnCwd` (owned by Workspace, spec 210)
   already delegates to `resolveWorktreeCwd`, which itself has a **parent-inheritance** branch
   (sub-agents share a parent's cwd) — so "many agents, one cwd" is already first-class and no invariant
   is violated. The pipeline adds a small Workspace-level branch (Mechanism B): a node belonging to a
   run resolves to the run worktree, bypassing the per-agent resolver. Modeled + asserted in the spike.

**NAME_RE constraint (caught in the spike):** `NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/` requires a leading
letter, so the synthetic key is **`run-<id>`**, NOT `__run_<id>` as the plan first wrote. `branchFor()`
then yields `tachyon/run-<id>`.

**Implication for the build:** Step 1+ can proceed on the planned design. The run worktree is owned by
`PipelineManager` (allocate on start via `ensure({agent:"run-<id>"})`, tear down on completion via
`remove()`), and Workspace's `resolveSpawnCwd` gets a pipeline-node branch. The spike test stays in the
suite as a guard and graduates into the pipeline test set.

**Decision:** proceed to Step 1 (loader + DAG validation). No return to the design gate.

## codex executor review (2026-06-18, after Step 4) → CHANGES → folded
Adversarial review (codex gpt-5.5, read-only) of `src/pipeline/*` + the Step 1-4 integration.
Confirmed sound: synchronous `tick()` marking running/verify-requested prevents double-spawn/verify
under JS interleaving; spawn-reject fails both signal* and exit* contracts; the `resolveSpawnCwd` seam
is real (`AgentManager.spawn` awaits the override at `AgentManager.ts:441`). Findings folded:
- **BLOCKER — shared-worktree fan-out was unenforced.** The loader accepted any DAG and the executor
  spawned all runnable siblings into the ONE run worktree → two writable siblings clobber it. FIX:
  the v1 loader now **rejects non-linear graphs** for `worktree: own` (one root, no fan-in/fan-out);
  parallel is a follow pass. This also dissolves the next finding (no concurrent siblings to strand).
- **MAJOR — failure could release the worktree while a sibling still ran.** Moot under linear; added a
  defensive guard in `finish()` (never release while any node is `running`).
- **MAJOR — auth/runtime registries never closed.** `finish()` now clears `nonces`/`signals`/
  `verifyRequested`/`cwd`/`wtKey` for the run (keeps `runs` for inspection) → a finished run is
  correctly "unknown/closed" to `complete_node` and the maps don't leak across runs.
- **MAJOR (Step 5 design) — `def.pipelineRun` tag won't survive ledger parse.** Folded into the plan:
  add a TYPED `SessionDef.pipeline?` field; `planResume`+`autostartPending` skip it.
- **MAJOR (Step 5 design) — node exit not wired to the executor.** Folded into the plan: map session →
  `{runId,nodeId}` and call `onProcessExit`/`onSessionEnd` from Workspace lifecycle callbacks.
Code fixes verified: full suite **651 green**, typecheck clean. Steps 5-7 carry the two design folds.

## EDH dogfood (2026-06-18, in tachyon-examples) — engine validated + 3 fixes

Ran the example pipelines in the EDH (dev build, opened on `~/tachyon-examples`).

**Test 1 (`smoke`) → PASS.** Run ledger recorded `hello: done`; the node ran in the run worktree
`run-<id>`; the agent's `complete_node` (per-node nonce) was accepted; the worktree + branch were
removed on completion; the session row carried the typed `def.pipeline` tag. Spawn run-scoped, nonce
auth, worktree-as-state, and teardown all confirmed in the field.

**Test 2 (`feature`, plan→implement→review) → validated the chain + surfaced 3 issues, all fixed:**
- **Chain + hand-off confirmed:** `implement` ran after `plan` and saw `PLAN.md`; `review` saw
  `PLAN.md`+`NOTES.md` — all in the one run worktree.
- **Finding 1 — lingering node sessions.** A completed node's agent row stayed in the ledger (worktree
  released but agent not dismissed); its cwd pointed at a removed worktree. FIX (`564391e`): the
  executor dismisses each node's agent (kill session + drop ledger row) on terminal; maps deleted
  before kill so `onKilled` doesn't re-enter.
- **Finding 2 (BLOCKER) — a reload orphans a running run.** The review agent correctly called
  `complete_node` with the right runId/nodeId/nonce, but got "unknown or closed pipeline run/node": a VS
  Code reload had rebuilt the PipelineManager EMPTY and the deferred on-activation reconcile meant the
  surviving (tmux) agent could never resolve its run. FIX (`8b5757b`): `PipelineManager.rehydrate()` +
  `Workspace.rehydratePipelines()` restore runs on activation (graph ← run ledger; nonce/cwd ← the
  session-ledger `def.env`, already persisted), re-arm per-node timeouts, drop terminal/gone runs.
- **Confirmed working:** the agent (codex) self-signalled correctly — the completion-protocol guidance
  works; the failure was Tachyon-side, not the agent. Good sign for the signal-based model.

**Design lesson recorded:** interactive agent nodes (`agent:` + `done: signal`) need the agent to call
complete_node (and may surface the agent's OWN approval prompts to the human). For hands-off automation,
`cmd:` + `done: exit` (`codex exec` / `claude -p`) is cleaner — exits on its own, no signalling. Add a
headless example variant as a follow.

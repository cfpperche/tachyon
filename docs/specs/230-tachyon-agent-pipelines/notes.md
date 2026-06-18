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

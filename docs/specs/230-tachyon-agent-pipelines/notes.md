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

## Empty-diff staleness (follow #1, 2026-06-18) — DONE run-level + codex-reviewed

`worktreeUnchanged(status)` (pure, verify.ts) + the pipeline `runVerify` dep: a `signal_then_verify`
node that passes verify but left the run worktree UNCHANGED vs its base fails as stale. codex review →
CHANGES, folded: **B1** capture staleness BEFORE running verify (verify artifacts would mask a no-op);
**M2** fail closed (stale:true) on a status-probe error / missing worktree. MINORs confirmed the helper
fields + baseRef are right. Commits `fedd9b2` + `ab79b62`. 672 tests green.

**OPEN FORK (codex MAJOR#1) — run-level vs per-node baseline.** Current impl is RUN-level (vs the run
base), as the maintainer scoped it ("diff vazio vs base da worktree da run"). codex argues run-level is
a correctness trap for a per-node done-contract: once an upstream node changes anything, a later no-op
`signal_then_verify` node reads `stale:false` (masked). Per-node would snapshot each node's baseline at
spawn and compare at signal — more correct, but needs a paths-returning status + per-node baseline state.
Deferred to the maintainer's decision (paused per the /goal protocol). Also: staleness only fires for
`signal_then_verify` nodes, which need `settings.worktree.verify`; the current examples don't have one
(and `npm test` needs deps in the fresh run worktree) — a true EDH dogfood needs a verify-gated example.

## Tier B — commit-per-node + re-run a COMPLETED run (DESIGN, 2026-06-18, debate-first)

Proposed design (my position; codex debate + maintainer sign-off pending — no code yet):

- **Commit-per-node (Q1/Q5).** After a node reaches `done` (signal+verify or exit), the executor runs
  `git add -A && git commit -m "pipeline <name>: <nodeId>"` IN the run worktree — one commit per node on
  the run branch `tachyon/run-<id>`. Same for `agent:` and `cmd:` nodes. If `git commit` reports
  "nothing to commit", the node produced nothing → **that IS per-node staleness**: fail the node as
  stale (content-based, robust vs in-place edits, unlike the path/run-level check). This SUPERSEDES the
  run-level worktreeUnchanged wiring. Committer = the repo's git user (Tachyon doesn't override identity).
- **Worktree-as-state intact (Q2).** Committing keeps the files in the working tree; downstream nodes
  read the working tree, unaffected. The commit only records the state on the branch.
- **Persist node→commit map (Q3).** The run ledger `.tachyon/runs/<id>.json` gains `nodeCommits:
  Record<nodeId, sha>`. Re-run from node N = recreate a worktree at the commit of N's last upstream node
  (linear: N-1's sha; root: the run base), then re-run N + downstream.
- **Branch lifecycle (Q4).** On completion: remove the WORKTREE but KEEP the branch + the run ledger
  (so re-run can branch from its commits). Delete the branch only on explicit **Dismiss**. → completed
  runs are now KEPT (visible in the tree as re-runnable), reversing the earlier "drop completed runs".
- **Re-run = a NEW run forked from N-1's commit (Q7).** Preserves the completed run's history (append-
  only ledger, old run inspectable). Cost: multiple runs per pipeline accumulate → the def tree shows
  the latest active/most-recent + the rest as history (UX to settle). Alternative: in-place overwrite
  (one run, simpler tree, loses history). LEAN: new run id.
- **Tier A interaction (Q6).** Tier B's commit-based reset could SUBSUME Tier A's live in-place reset
  (unify: re-run from N always = branch from N-1's commit, live or completed). LEAN: unify on commits
  once commit-per-node exists — Tier A's bespoke live-reset becomes redundant. dismiss now also deletes
  the branch; rehydrate restores nodeCommits so a completed run survives a reload re-runnable.

Open risks for the debate: committing in a shared worktree vs the human's own git use; a verify gate
that itself commits; partial-failure (commit fails mid-run); the cost/UX of accumulating forked runs;
whether unifying Tier A onto commits is worth the churn.

### codex debate (2026-06-18) → VERDICT: DEFER (agreed)
codex (gpt-5.5, read-only) recommends NOT building Tier B for v1 — 2 BLOCKER + 3 MAJOR, all real:
- **B1 — `git add -A` is unsafe.** It stages every non-ignored secret / `.env` / build artifact / verify
  output in the run worktree (the existing review path deliberately uses `ls-files --others
  --exclude-standard`, not staging). Commit-per-node turns the pipeline into a git product owing scoped
  staging + secret deny-lists + size/binary caps + a commit preview/approval. Big obligation.
- **B2 — conflicts with the current lifecycle.** Completion finalizes + drops the run + releases the
  worktree; rehydrate deletes terminal run ledgers; `PipelineRun` has no `nodeCommits`. Tier B = schema +
  retention policy + migration + UI history + branch cleanup, not an executor patch.
- **MAJOR — "nothing to commit" is a bad universal stale signal:** false-fails read-only / planning /
  audit / ignored-output / net-zero nodes. Better: a per-node `expectsChange: true|false|paths`.
- **MAJOR — fork-from-commit path is incomplete** (createFork's `baseBranch` semantics; no
  allocate-from-arbitrary-ref API) — needs a new `createFromRef`.
- **MAJOR — atomicity underspecified:** commit fail / reload between done and the commit landing; needs a
  `committing` state + transactional persist/reconcile.
- **MINOR — forked runs clutter the def tree** (one-active-run UX) until a collapsed-history model exists.

**Synthesis (agreed):** DEFER Tier B. **Tier A already covers re-run-from-a-step for LIVE runs
(paused/failed)** — the common case (review a gate, re-run implement). Re-running a COMPLETED run
(worktree gone) is the rarer case, and commit-per-node's cost (git safety + lifecycle + atomicity) is
high for that marginal gain. Higher-value, lower-risk alternative: keep Tier A live + add a light
per-node `expectsChange` declaration for staleness (no commits, no false-fails). Revisit Tier B if/when
re-running finished runs becomes a real, repeated need. AWAITING maintainer sign-off (paused).

## Re-run from a step — design (planned, 2026-06-18, maintainer request)

Goal: re-run a pipeline from an already-executed node (e.g. redo `implement` onward, keep `plan`'s
output), or retry a single node. The hard constraint is **where the upstream state lives** — the run
worktree is the state, and `finish()` REMOVES it on terminal. Two tiers:

- **Tier A — while the run is alive (paused at a gate, or failed): re-run from node N (no commits needed).**
  The run worktree still exists, so the upstream nodes' output files are right there. "Re-run from N" =
  reset node N + its transitive downstream to `pending`, clear their signals / dismiss their agents,
  re-tick. A tree ↻ action on a node. Prereq: do NOT release the worktree on `paused`/`failed` — only on
  full completion or explicit Dismiss (today failure releases it; change to keep-until-dismiss). This is
  the cheap, high-value slice and likely the MVP for this feature.
- **Tier B — re-run from a step of a COMPLETED run (worktree already gone).** Needs per-node COMMITS to
  the run branch (a commit per node), so re-run-from-N = branch a fresh worktree from node (N-1)'s commit.
  This is exactly the git-branch hand-off rejected for the v1 node model — it becomes worthwhile HERE.
  Bigger; ties into keeping the run branch after completion. Defer until Tier A proves the need.

Also folds the existing **retry-node** follow (codex M3 preflight): retry-single-node = the Tier-A reset
of just that node (preflight worktree/branch/HEAD/upstream-still-done before re-running).

Open question for later: does "re-run from N" reuse the SAME run id (history overwritten) or fork a NEW
run from N (history preserved)? Lean: new run id, seeded from the prior run's worktree state — keeps the
run ledger append-only and the prior run inspectable.

**Design lesson recorded:** interactive agent nodes (`agent:` + `done: signal`) need the agent to call
complete_node (and may surface the agent's OWN approval prompts to the human). For hands-off automation,
`cmd:` + `done: exit` (`codex exec` / `claude -p`) is cleaner — exits on its own, no signalling. Add a
headless example variant as a follow.

# Orca: orchestration, task lifecycle, and land — measured against ours

_2026-08-09. Source read, not documentation: `stablyai/orca`, MIT, commit `34f2a62`._

The question behind this was the maintainer's: keep cleaning product opinion out of Tachyon and keep only
governed mechanisms. So the interesting thing about Orca is not what it builds — it is what it refuses
to decide.

## 1. Land: Orca performs no local merge

`git merge` is invoked locally **zero times** for integration. The only local merge in the tree is
`merge --abort` (`src/main/git/status.ts:1052`), which is cleanup.

Every integration goes through the forge:

| path | file |
|---|---|
| `gh pr merge <n> --<method>` | `src/main/github/client.ts:4669` |
| `gh pr merge <n> --auto --<method>` | `src/main/github/client.ts:4766` |
| GitLab merge (`merge`/`squash`/`rebase`) | `src/main/gitlab/client.ts:890` |
| Gitea, Bitbucket, Azure DevOps | `src/main/source-control/hosted-review-*` |

The mergeability verdict is **read, never computed**. `client.ts:510` requests exactly these fields
from the forge and renders them: `statusCheckRollup`, `reviewDecision`, `mergeable`,
`mergeStateStatus`, `autoMergeRequest`, `latestReviews`, `reviewRequests`.

**Consequence, both directions.** Orca inherits whatever governance the repository already has —
required checks, review rules, protected branches — without owning a policy of its own. And without a
forge, Orca has no land story at all.

### Ours

`src/worktree/land.ts` computes five preconditions itself — `worktree-clean`, `verified-tree`,
`fast-forward`, `primary-on-trunk`, `primary-clean` — and when all five pass, puts
`git -C <primary> merge --ff-only <sha>` on the clipboard. A human pastes it.

So the axis is not "button vs clipboard". It is **who holds the policy**: we do, they delegate.

## 2. Orchestration: coordinator/worker over SQLite

`src/main/runtime/orchestration/`. A *run* has an objective, a coordinator handle, and a task DAG.

Typed messages (`types.ts:1`): `status`, `dispatch`, `worker_done`, `merge_ready`, `escalation`,
`handoff`, `decision_gate`, `question`, `heartbeat`.

Machinery worth naming:

- **Capability per dispatch** — `launch_token_hash`, `capability_hash`, `process_incarnation`,
  `capability_revoked_at`. Revocation is a timestamp on the dispatch, not a process signal.
- **Circuit breaker** — `failure_count >= 3` moves the dispatch to `circuit_broken` and the task to
  `failed` (`db.ts:4526`, `db.ts:6563`). The count is carried forward across retries of the same task
  (`db.ts:6183`) so retrying cannot reset the breaker.
- **Completion is a reported fact.** `worker_done` must carry `taskId`, `dispatchId`, and
  `outcome ∈ {succeeded, failed}`; anything missing is a typed rejection
  (`lifecycle-reconciliation.ts`). Process exit never completes work.
- **Federation** — dispatches can live on another machine, with sequence-numbered relay in both
  directions.

**`merge_ready` is machinery with no inlet.** It is in the message enum, in the DB CHECK constraints
(`db.ts:341`, `640`, `769`), and in the RPC allowlist (`rpc/methods/orchestration.ts:75`). Both
consumers ignore it: `coordinator.ts:251` falls through to `break`, and
`lifecycle-reconciliation.ts:115` returns `{ action: 'ignored' }`. It is a mailbox notification for
whoever reads the mailbox — the product does nothing with it. Recorded here because Tachyon has been
sweeping this exact class (`t-e50995`); it is not a defect unique to us.

## 3. Task lifecycle: three tables, three vocabularies

```
tasks.status              pending | ready | dispatched | completed | failed | blocked
dispatch_contexts.status  pending | dispatched | completed | failed | circuit_broken
worker_dispatches.state   starting | ready | start_unknown | failed | succeeded
                          stopping | stop_unknown | stopped | abandoned
```

Two properties follow from the split, and they are the whole point:

1. **Ownership lives on the dispatch, not the task.** `assignee_handle` is a `dispatch_contexts`
   column. Returning a task to `ready` therefore erases nothing — the attempt, its failure count and
   its last error stay on the dispatch row.
2. **"I don't know" is spelled out.** `start_unknown` and `stop_unknown` exist because the product
   sometimes cannot observe the outcome, and recording a guess would be the defect.

### Death of a worker (`db.ts:4509`, `reconcileMissingWorkerTerminal`)

```
stopWasPending = worker.state === 'stopping' || worker.state === 'stop_unknown'
if (activeDispatch) {
  dispatch → failed | circuit_broken (failure_count + 1)
  if (!stopWasPending) {
    tasks.status → ready | failed   WHERE status IN ('dispatched','blocked')
  }
}
worker_dispatches.state → stopWasPending ? 'stopped' : 'abandoned'
```

**A requested stop does not move the task lane. Only a disappearance does.**

### Scope and retention

Tasks belong to a run and are deleted with it (`db.ts:6763`). Orca has **no durable project board** —
for that it integrates the user's own: `src/main/linear/`, `src/main/jira/`.

### Ours

`TaskStore` has one `status` doing all three jobs, and `assignee` lives on the task. Since the store
refuses `active` without an assignee (`TaskStore.ts:933`), clearing the owner — the only fact process
death proves — forces the lane to move. That is the mechanism behind `t-49d7ec`, where 25 delivered
tasks sat in `triaged` claiming nobody had done them.

**One Orca argument does not transfer.** Their guarded `UPDATE ... WHERE status IN (...)` guards
against concurrent SQL. Our `withMutation` (`TaskStore.ts:615`) already serialises mutations into a
promise chain, so our read-filter-write is atomic against other mutations. Credit to the agent working
`t-49d7ec` for refusing this point.

## 4. Where we hold an opinion and they hold a mechanism

| | Orca | Tachyon |
|---|---|---|
| may this land? | the forge answers | we compute five preconditions |
| who owns a claim | the dispatch row | the task row |
| process died | the dispatch records it; a requested stop leaves the task alone | the task lane is rewritten |
| unknown outcome | a named state | not representable |
| the board | not owned; Linear/Jira integrated | owned and durable |

## 5. What is worth copying, and what is not

**Worth copying now.** The requested-stop distinction, already in flight as `t-49d7ec`.

**Worth deciding, not copying.** Replacing local merge with a mandatory forge would swap one imposed
opinion for a more expensive one — it would make Tachyon unusable without GitHub. The path already
started in SDD 497 is better and reaches the same place: the product **reads** evidence produced by any
CI, and a forge becomes one publisher among several rather than the only authority.

**Not worth copying now.** Splitting task/dispatch/worker into three tables is a board rewrite. The
value is real and the cost is not justified by anything measured yet.

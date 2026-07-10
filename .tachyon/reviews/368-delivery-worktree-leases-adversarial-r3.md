# T0.2 Adversarial Closure Review — SDD 368 fenced handoff

**Reviewer:** review368r2 (spawned by codex)  
**Date:** 2026-07-10  
**Scope:** R2-F1 fold only in `docs/specs/368-delivery-worktree-leases/{spec,plan,tasks,notes}.md`; read-only
architecture review with no implementation changes.  
**Verdict:** **FINDINGS** — the direct predecessor-runtime overlap and free-gap defects are closed, but the fence
does not yet exclude surviving descendant processes.

## Sequence closure check

The folded documents consistently specify:

1. `held → draining` retains the predecessor lease and makes contention visible.
2. Runtime stop occurs outside the durable record lock.
3. A second short critical section proves tmux and the captured root process gone and revalidates clean Git state,
   expected HEAD, linear history, and scope.
4. That same transition closes the predecessor segment and writes the nonce-bound `pending` successor reservation.
5. Spawn occurs outside locks; confirmation changes only that exact reservation to `held`.
6. Failure consumes the reservation and never implicitly revives the predecessor; restart is a new segment.

This guarantees no observable `free` state: authority moves from `held/draining` directly to `pending`, and all
contenders receive `WORKTREE_OCCUPIED`. It also prevents overlap with the predecessor's tmux session and captured
root process. The sequence is represented in `spec.md:45–50,64–78`, `plan.md:70–92,168–171`,
`tasks.md:35–38`, and `notes.md:44–53`.

## Remaining finding

### R3-F1 — HIGH — root-process death is not a process-tree fence; an orphan descendant can overlap successor spawn

**Exact unresolved clauses:**

- `spec.md:69,74–76` requires proof that the predecessor and its **root process** are stopped, but does not require
  proof that all descendant processes capable of accessing the Delivery worktree are gone.
- `plan.md:84–87` allows the successor reservation after tmux and the captured root process are proven gone plus
  one instantaneous Git recheck.
- `tasks.md:35–38` repeats predecessor/root-gone as the T7 implementation and gate, without a descendant/process-
  group/cwd-holder fence.
- This is inconsistent with the already-folded crash rule at `plan.md:105–120` and T11, which recognizes a live
  child PID as a reason to quarantine rather than free the worktree.

**Concrete failure scenario:** The predecessor launches a background watcher or test worker that becomes
reparented/detached, retains the Delivery cwd or an open path to it, and writes generated files after a delay.
Tachyon marks `draining`, terminates tmux and the captured pane-root PID, and proves both gone. The orphan child is
still live. Git is clean at the second critical section, so Tachyon closes the predecessor segment, records
`pending`, and starts the successor. The orphan then writes while the successor reads or operates in the same
worktree. The nonce and no-free-gap state protect lease metadata, but not filesystem exclusivity.

**Required resolution:** Before `draining → pending`, prove the predecessor's entire owned process group/tree is
gone using a durable process identity that cannot be defeated by PID reuse, and check for surviving processes
whose canonical cwd/open worktree binding identifies the Delivery. If complete absence cannot be proven, remain
fail-closed/quarantined and do not spawn. Amend the T7 gate with a detached/reparented child that outlives the
pane-root process and assert successor spawn is refused until the child is gone. Reuse the same child-liveness
predicate required by T11 so handoff and crash reconciliation cannot disagree about whether the worktree is safe.

## Evidence inspected

- Full current `spec.md`, `plan.md`, `tasks.md`, and `notes.md`.
- The R2-F1 artifact and every folded fenced-handoff clause.
- State transitions and failure compensation for `held → draining → pending → held`.
- Existing liveness/quarantine clauses for descendant-process consistency.

No style finding is reported. R3-F1 is a concrete concurrent-filesystem-access failure, so production delegation
remains blocked pending one more fold and closure check.

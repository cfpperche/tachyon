# T0.1 Adversarial Architecture Re-review — SDD 368 delivery-worktree-leases

**Reviewer:** review368r2 (spawned by codex)  
**Date:** 2026-07-10  
**Scope:** folded `docs/specs/368-delivery-worktree-leases/{spec,plan,tasks,notes}.md` against
`.tachyon/reviews/368-delivery-worktree-leases-adversarial.md` F1–F9. Read-only design closure gate; no
implementation reviewed or performed.  
**Verdict:** **FINDINGS** — do not delegate production implementation until R2-F1 is resolved.

## F1–F9 closure matrix

| Prior finding | Disposition | Acceptance criteria | Plan | Tasks | Re-review result |
|---|---|---|---|---|---|
| F1 reload ambiguity / PID reuse | folded | reload fail-closed, lines 133–138 | liveness token and unknown quarantine, lines 105–120 | T11, T14 | resolved |
| F2 verifier checks segment zero | folded | verification exclusion uses current holder, lines 87–92 | canonical-current-holder verification lease, lines 94–101 | T9 | resolved |
| F3 ambiguous legacy name | folded | exactly-one legacy resolution, lines 146–150 | mtime forbidden, lines 55–59 | T4 | resolved |
| F4 stale lock wedge | folded | provably-dead reclamation and explicit recovery, lines 140–144 | stale-owner protocol, lines 40–47 | T1 | resolved |
| F5 lock held across spawn | folded, but introduced R2-F1 | pending visibility, lines 45–49 | reserve/spawn/confirm, lines 80–86 | T7 | regression |
| F6 execution-name authority | folded | lifecycle authority excludes name equality, lines 160–164 | Bridge/configured policy only, lines 128–135 | T12, T13 | resolved |
| F7 projection race | folded | canonical-lock serialization and replay, lines 152–158 | canonical-lock projection updates, lines 145–151 | T15 | resolved |
| F8 non-linear boundaries | folded | ancestor-linear history, lines 75–79 | verify/import refuse non-linearity, lines 94–101 | T3, T5, T9 | resolved |
| F9 interrupted checkout | folded | clean intent-based restore, lines 94–98 | persisted verification intent, lines 94–97 | T9 | resolved |

All original F1–F9 dispositions are explicit in `notes.md`. Apart from the F5 regression below, each is
internally consistent and represented in acceptance criteria, plan, and tasks.

## Remaining finding

### R2-F1 — HIGH — successor spawn begins while the predecessor is still the live holder, violating exclusive occupancy

**Exact unresolved clauses:**

- `plan.md:80–84`: the first mutation validates **prior-holder liveness**, writes `pending`, releases locks,
  spawns the successor, and only on the second mutation **closes the predecessor**.
- `tasks.md:35–37` (T7): reserve → spawn → confirm does not require the predecessor runtime to be durably
  stopped before spawn or prove that it cannot touch the worktree during the unlocked interval.
- This conflicts with `spec.md:16–20` (exclusive sequential leases), `spec.md:33–37` (roles acquire in
  sequence), and `spec.md:63–67` (atomic transfer without an observable free/authority gap).

**Concrete failure scenario:** Implementer A is live and clean at expected HEAD. The coordinator requests a
reviewer successor. Under the written flow Tachyon records `pending` while A remains the live holder, releases
both locks, and starts reviewer B in the same worktree. Before B confirms, A resumes and edits or commits. B is
already booting against that cwd and may read or mutate it concurrently. Confirmation can refuse the changed
HEAD, but that is too late: two runtimes already shared one worktree, and B may have based review output on a
mixed tree. If B fails to start, “restore a provable predecessor” also cannot undo any partial reads/writes from
the attempted successor.

The nonce prevents a stale confirmation and the pending state prevents a third acquisition, but neither fences
the existing holder from the filesystem. A social “ready to release” promise is not an enforceable exclusive
lease.

**Required resolution:** Specify a fenced two-phase transfer. Before spawning the successor, the predecessor
must be durably stopped/disconnected from the Delivery worktree (with termination/liveness proof), its segment
closed at a clean expected HEAD, and the pending reservation must remain the sole authority. Spawn may then run
outside the short mutation lock. If keeping rollback-to-predecessor is desired, restart it as a new nonce-bound
execution/segment after successor failure; do not leave the old live runtime capable of writing during spawn.
Add acceptance language and a T7 gate that pauses transfer after reservation, attempts a predecessor write, and
proves it cannot mutate the worktree before successor confirmation.

## Evidence inspected

- Full folded `spec.md`, `plan.md`, `tasks.md`, and `notes.md`.
- Full first-round adversarial review and every F1–F9 resolution clause.
- Cross-document trace from each finding to acceptance criteria, design mechanism, and implementation task/gate.
- Focused handoff state machine and reservation text at `plan.md:61–101` for regressions caused by the fold.

No style-only findings are reported. R2-F1 is a concurrency failure that permits simultaneous access to the one
Delivery worktree the design exists to make exclusive.

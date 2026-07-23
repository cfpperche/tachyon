# 433 — Live canonical profile rename

_Created 2026-07-22._

**Status:** shipped

**Closure:** Running and stopped canonical rename now converge through one recoverable journal; focused and full verification are recorded in `notes.md`.

**Task:** `t-c3605c` · **Parent:** `t-c111e4` / SDD 431

**Affected Product Invariants: none —** PI-001 concerns project-guidance ownership. This slice changes only rename convergence for an already-owned runtime.

## Intent

Allow a running profile-backed agent to use the persistent rename transaction from SDD 432 without restarting or replacing its process. Before the profile authority commits, capture the exact live bindings that belong to the source. After that commit, converge the tmux session, session ledger, child lineage references and activity files to the destination through replayable pair states. Ephemeral terminal presentation and in-memory indexes are rederived only after durable state converges.

The SDD 432 journal remains the single admission barrier. It is extended with the captured live snapshot and a `live-converged` phase; both names remain blocked until persistent identity and live bindings agree at the destination.

## Acceptance criteria

- [x] **Running profile rename keeps the same process/session**: old tmux session becomes the destination session, with no kill, respawn or new runtime identity.
- [x] **Stopped profile rename remains unchanged**: no live artifacts are invented.
- [x] **Replay is pair-state based**: exact source/absent destination performs each move; absent source/exact destination acknowledges it; collisions degrade and keep both names blocked.
- [x] **Ledger move is one durable write**: the owned row moves and every child `parent`/`delegator` reference changes in the same replacement.
- [x] **Activity move is lossless**: captured source ownership moves without dropping events appended during the transaction.
- [x] **Crash recovery converges** after tmux, ledger, activity or activation boundaries without repeating a destructive action.
- [x] An isolated-harness agent or managed Pi session is rejected before the profile authority commit, preserving the existing capability boundary.
- [x] An open terminal tab is closed before tmux rename and reopened at the destination only after durable convergence; a closed tab stays closed.

## Non-goals

- Renaming isolated harness homes or managed Pi transcript namespaces.
- Rewriting runtime-owned transcript contents or changing runtime session IDs.
- Forget/retirement and name reuse (`t-980e6e`).
- General transaction infrastructure or distributed/multi-process coordination.

## Open questions

None. The parent architecture review already established the persistent/live split; this slice implements that boundary.

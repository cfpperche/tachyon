# 376 — retire-legacy-delivery

_Created 2026-07-13._

**Status:** in-progress

## Intent

Tachyon currently carries two delivery lifecycles. A gated spawn may still persist a legacy
`DelegationRecord`, open a Delivery-less `GitDelivery`, hand a worktree to a fixer through
`reuse_worktree`, and verify by agent-name lookup. The canonical path instead persists one `Delivery`,
one linked Git projection, one immutable verification contract, and sequential occupants of the same
worktree. Configuration still lets an installation select either path, so convention rather than the
product decides which model is used.

Remove the legacy delivery lifecycle instead of completing spec 368. Canonical Delivery with the
currently dogfooded mechanism-only handoff becomes the only product path for tracked delegated work.
GitDelivery remains only as the Git projection of a Delivery; generic agent/terminal sessions remain
possible but cannot masquerade as a tracked Delivery. Existing legacy metadata is retired through a
bounded, explicit, non-destructive upgrade step and is never read as live authority again.

## Acceptance criteria

- [x] **Scenario: there is no delivery mode switch**
  - **Given** any valid Tachyon workspace configuration, including one with no delivery settings
  - **When** Tachyon starts
  - **Then** tracked gated work always uses canonical Delivery with mechanism-only handoff
  - **And** `settings.delivery.mode` and `settings.delivery.handoffSafety` never select behavior or enter the runtime config
  - **And** an old `settings.delivery` block is ignored with a visible warning and Doctor finding instead of disabling the workspace

- [x] **Scenario: a new tracked delegation has one canonical identity**
  - **Given** an agent starts change-producing work with a gate, immutable verifier, owned paths, and base SHA
  - **When** `spawn_agent` succeeds
  - **Then** it creates exactly one Delivery, one linked GitDelivery projection, one worktree, and segment zero
  - **And** its response returns the exact Delivery id, projection id, segment id, worktree, branch, and pinned HEAD
  - **And** no `DelegationRecord` or Delivery-less GitDelivery is written

- [x] **Scenario: every successor uses the Delivery lease**
  - **Given** an existing Delivery is ready for a reviewer, fixer, or later implementer
  - **When** a successor is spawned
  - **Then** `delivery_join` with the exact Delivery id is the only worktree-reuse API
  - **And** `reuse_worktree`, delegation-id sugar, agent-name sugar, and fallback worktree creation are unavailable

- [x] **Scenario: verification is canonical-only**
  - **Given** a tracked delegated change
  - **When** `verify_task` runs
  - **Then** `delivery_id` is required and the verifier reads the Delivery contract and segment history directly
  - **And** it cannot resolve an agent name or construct/read a `DelegationRecord` compatibility view

- [x] **Scenario: GitDelivery is projection-only**
  - **Given** any live GitDelivery record
  - **When** it is listed, integrated, reconciled, or pruned
  - **Then** it has exactly one immutable `deliveryId` and all mutation runs through `DeliveryProjectionService`
  - **And** public `git_delivery_open`, standalone auto-open, unlinked mutation, and legacy-import reservation are unavailable

- [x] **Scenario: old state is retired without deleting Git work**
  - **Given** legacy delegation files, Delivery-less GitDelivery rows, or old JSON store mirrors
  - **When** the maintainer runs the one-time retirement action after reviewing its preview
  - **Then** Tachyon archives the raw metadata plus an inventory and removes it from active stores through a
    crash-recoverable, idempotent retirement protocol
  - **And** it does not delete or modify a branch, commit, worktree, working-tree file, or canonical Delivery
  - **And** an interrupted or ambiguous retirement fails closed with a recoverable diagnostic

- [x] **Scenario: an upgrade cannot silently reactivate the old lifecycle**
  - **Given** active legacy metadata is detected before retirement
  - **When** a tracked Delivery operation is requested
  - **Then** it is refused with one actionable retirement diagnostic while the Bridge and generic session management stay available
  - **And** after retirement, reload reads only canonical Delivery, linked projection, and session-ledger state

- [x] **Scenario: generic sessions remain a separate primitive**
  - **Given** a declared home agent, terminal, pipeline process, or explicitly ungated scratch session
  - **When** it starts without a Delivery gate or join
  - **Then** normal session behavior remains available
  - **And** it receives no Delivery identity, GitDelivery projection, verification eligibility, or implicit isolated-change lifecycle

- [x] **Scenario: the canonical happy path dogfoods end to end**
  - **Given** a clean temporary repository and the installed extension
  - **When** one real implementer is gated, verified, reviewed with FINDINGS, fixed through `delivery_join`, reverified, and accepted
  - **Then** every role uses the same Delivery, branch, and worktree
  - **And** no active legacy file/row, unlinked projection, sibling worktree, or compatibility API is observed

- [x] Outside the bounded raw-state retirement module and its fixtures, production source and current tests
  contain no executable delivery-lifecycle dependency on
  `DelegationRecord`, `reuse_worktree`, legacy verification resolution, `delivery_import_legacy`,
  Delivery-less GitDelivery mutation, or a selectable legacy/disabled delivery mode.
- [x] Historical specs may describe the retired behavior; the config schema retains only a deprecated, effect-free
  `settings.delivery` compatibility key so upgrades remain loadable, while current product documentation and tool schemas expose only the canonical lifecycle.

## Non-goals

- Finishing, closing, or claiming the remaining acceptance criteria of spec 368.
- Wiring `process-fenced`, completing T14.6C, or proving detached-child/crash-recovery guarantees.
- Deleting the reviewed ProcessFence experiment; it stays unreachable from product configuration until a separate spec decides its future.
- Auto-merge, auto-push, auto-prune, automatic dirty-tree recovery, or destructive cleanup.
- Converting historical legacy records into new live Deliveries; historical metadata is archived, not promoted into authority.
- Deleting legacy branches or worktrees. Their cleanup is a separate, explicit Git hygiene decision.
- Removing unrelated uses of “legacy” elsewhere in Tachyon, such as Bridge-auth migration or UI compatibility code.
- Turning every managed terminal or persistent home session into a Delivery.

## Open questions

None. The maintainer selected a hard product cut to canonical mechanism-only behavior. The retirement action is
the bounded upgrade bridge; no runtime compatibility mode survives after it.

# 431 — Agent profile identity lifecycle

_Created 2026-07-22._

**Status:** shipped
**Closure:** Shipped through `t-152041` (`599441cc`), `t-c3605c` (`885f8e9d`) and `t-980e6e` (`c8bcf33c`); all child SDDs and final compatibility gates are green.
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`

**Task:** `t-c111e4` · **Parent:** `t-e50d4f` / SDD 429 · **Depends on:** SDD 430

**Affected Product Invariants: none —** PI-001 concerns project-guidance ownership and remains unchanged. This slice does not alter prompt composition.

## Intent

Canonical profiles now have safe create/edit/enable transactions, but rename and forget still use legacy paths that do not understand profile identity or its host-custodied authority. Rename currently moves the live session before persistent identity commits; forget can broadly remove runtime homes and other state without a profile retirement record. A crash can therefore split one identity across two names or erase data outside Tachyon's ownership.

This slice adds recoverable identity operations to the host-owned lifecycle boundary. Rename keeps the same `agentId`, moves only Tachyon-owned locators and canonical bytes, and converges live/session state after the canonical commit. Forget first records retirement, retires authority and locator, then removes an explicit allowlist of profile-owned or disposable artifacts. External bindings are diagnosed and retained. Unresolved rename/forget journals block both affected names from launch and reuse.

## Delivery decomposition

Independent review showed that persistent identity move, live-session convergence and destructive retirement have different commit points and recovery state. This SDD coordinates three ordered implementation slices:

1. `t-152041` — stopped-agent canonical rename: two-name locks, profile/authority/config/Evolution move and recovery.
2. `t-c3605c` — idempotent live-session convergence after canonical rename.
3. `t-980e6e` — stopped-only forget, retirement receipts, custody-qualified cleanup and safe name reuse.

The umbrella closes only when all three pass their own SDD and compatibility gates.

## Identity and retirement contract

- Rename is an identity move, not clone: old and new names bind the same `agentId` and exact canonical content.
- The profile authority store performs one compare-and-move from old name to new name; authority/grants are neither copied nor recreated.
- Canonical commit precedes live rename. Until live convergence succeeds, the journal blocks launch under both names and recovery retries idempotently.
- Forget requires the agent to be stopped. A durable tombstone binds name, `agentId`, revision and owned cleanup plan before authority/locator retirement.
- Profile forget may remove canonical `agent.yml`, Tachyon-managed Evolution state after its authority retirement, continuity/activity/session metadata and disposable projections. It does not remove harness/runtime homes, runtime-managed memory, plugins, worktrees, external references or secrets.
- A name remains unavailable while any identity journal involving it is unresolved. A completed retirement permits later reuse with a fresh `agentId`.

## Acceptance criteria

- [x] **Scenario: rename preserves identity**
  - **Given** a profile-backed agent and free destination name
  - **When** rename commits
  - **Then** the canonical directory, locator and authority move to the destination with the same `agentId`, grants and profile bytes
- [x] **Scenario: canonical commit precedes live convergence**
  - **Given** a running or stopped profile-backed agent
  - **When** rename is requested
  - **Then** persistent identity commits first, live/session state converges afterward, and both names remain blocked while convergence is incomplete
- [x] **Scenario: rename conflicts fail closed**
  - **Given** a stale revision, occupied destination, worktree/path collision or concurrent writer
  - **When** rename is attempted
  - **Then** no second identity is created and diagnostics reveal no authority content
- [x] **Scenario: forget retires before deletion**
  - **Given** a stopped profile-backed agent and current revision
  - **When** forget commits
  - **Then** authority and locator retire before allowlisted canonical/projection cleanup and a completed retirement receipt remains inspectable
- [x] **Scenario: forget preserves external state**
  - **Given** runtime homes/memory, plugins, worktrees, secrets or other external bindings
  - **When** forget commits
  - **Then** those resources remain untouched and retained-binding diagnostics identify them without exposing secrets
- [x] **Scenario: crash recovery is deterministic**
  - **Given** interruption after any durable rename or forget phase
  - **When** startup reconciliation runs
  - **Then** it finishes the known target, restores a provable prior state, or leaves a degraded journal blocking both names
- [x] Name reuse is refused during unresolved retirement and allowed only after completion with a fresh `agentId`.
- [x] Legacy rename/forget behavior remains compatible for non-profile agents.

## Non-goals

- Clone, import/export or portable bundles (`t-999e4f`).
- Agent Studio UI/protocol (`t-149877`).
- Moving or deleting runtime-managed memory, harness homes, plugins, worktrees, secrets or external stores.
- Changing Agent Evolution's approval model; this slice calls its existing move/retire boundary.
- Renaming managed Pi or isolated-harness live sessions where the existing runtime path already refuses it.

## Open questions

None before implementation; independent review must validate the commit point and cleanup allowlist.

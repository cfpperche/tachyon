# 436 — canonical-profile-forget

_Created 2026-07-22._

**Status:** shipped
**Closure:** Shipped in task `t-980e6e`; canonical forget is recoverable, identity-qualified, fail-closed, and covered by full verification plus focused dogfood.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Deleting a profile-backed agent still falls through the legacy broad cleanup path. That path is keyed only by the mutable agent name, removes runtime homes, and deletes Evolution storage directly; after a crash or name reuse it cannot prove that the bytes still belong to the retired identity.

Provide one recoverable canonical forget transaction keyed by the immutable `agentId`. It must block new launches before the final stopped check, make an explicit roll-forward decision before retiring either authority, remove the exact config locator, quarantine the exact canonical home, and leave anything whose ownership cannot be proved untouched and diagnosed. A completed receipt permits the name to be reused with a fresh `agentId` and cannot trigger later cleanup.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: stopped canonical profile is retired**
  - **Given** a stopped profile-backed agent with matching profile authority, config locator, and optional Evolution profile
  - **When** the user removes the agent
  - **Then** both authorities are retired, the exact locator disappears, the canonical home is quarantined under its `agentId`, trusted config reloads, and a durable committed receipt remains
- [x] **Scenario: launch races forget**
  - **Given** a canonical forget intent has been persisted
  - **When** a launch or restart is attempted for that name
  - **Then** admission fails before creating or replacing a session; forget also rechecks tmux after publishing the intent
- [x] **Scenario: crash after commit decision**
  - **Given** a crash or lost acknowledgement after the journal enters the irreversible committing phase
  - **When** workspace startup reconciles transactions
  - **Then** recovery only rolls forward and converges authority, locator, quarantine, and receipt idempotently
- [x] **Scenario: custody changed**
  - **Given** profile bytes, authority, locator, or a cleanup artifact no longer matches the captured identity evidence
  - **When** forget or recovery reaches that boundary
  - **Then** the transaction becomes degraded, the mismatched artifact is retained, and the name remains blocked
- [x] **Scenario: name reuse**
  - **Given** a completed retirement receipt for an old `agentId`
  - **When** the same name is created again
  - **Then** it receives a fresh `agentId`; the old receipt and quarantine cannot delete or block the new identity
- [x] Runtime harness homes, Pi homes, worktrees, runtime secrets, and plugin data outside the captured canonical home are never deleted by canonical forget.
- [x] Legacy non-profile delete behavior remains unchanged.

## Non-goals

- Redesigning per-agent plugin installation; a quarantined canonical home merely preserves any future profile-local plugin subtree.
- Migrating runtime-managed memory or deciding whether a runtime may inject that memory.
- Automatically deleting retained runtime homes, worktrees, secrets, or ambiguous name-only artifacts.
- Supporting forget of a running profile; explicit stop remains required.

## Open questions

None. The parent architecture review established the identity, admission, custody, and roll-forward boundaries used here.

# 450 — Remove legacy agent format

_Created 2026-07-25._

**Status:** in-progress

## Intent

The last inline/legacy agent has been retired and replaced by a canonical profile. Tachyon still
accepts inline agent definitions in `tachyon.yml`, exposes migration preview/commit/rollback commands,
and keeps migration journals and recovery code. That compatibility surface can create new legacy
state even though Agent Studio now owns canonical profile creation.

Remove the legacy agent representation and the abandoned migration rollout in one release. Agent
declarations under `agents:` become exact canonical profile locators; terminal declarations retain
their existing operational syntax under `terminals:`. Extract the transaction primitives used by
canonical create/edit/rename/forget from the migration-named module before deleting migration-only
planning, journaling, recovery, rollback, commands, tests and documentation.

## Acceptance criteria

- [x] **Scenario: inline agents fail closed**
  - **Given** an `agents.<name>` declaration containing `cmd` or any other inline runtime field
  - **When** Tachyon parses or reloads the workspace configuration
  - **Then** it rejects the declaration and directs the operator to create a canonical agent profile
- [x] **Scenario: canonical agents and terminals remain supported**
  - **Given** exact canonical pointers under `agents:` and operational definitions under `terminals:`
  - **When** Tachyon loads or mutates a canonical agent, or manages a terminal
  - **Then** the existing canonical lifecycle and terminal behavior remain intact
- [x] **Scenario: migration cannot be invoked**
  - **Given** the extension command surface and engine protocol
  - **When** their commands and schemas are inspected
  - **Then** no agent-profile migration preview, commit, rollback or rollback-list operation exists
- [x] **Scenario: abandoned migration state is retired**
  - **Given** the installed workspace residue from the aborted rollout, including transaction
    `22609f0b-885a-48a2-a429-18544d1b3669`
  - **When** cleanup completes
  - **Then** migration journals, receipts and orphaned host authority are absent without changing any
    active canonical agent authority
- [x] Canonical lifecycle transaction primitives live in a migration-neutral module and no production
  module imports `agentProfileMigration`.
- [x] Migration-only tests and dogfood are removed; retained tests cover canonical lifecycle recovery,
  configuration rejection and terminal compatibility.
- [x] Current architecture and operator documentation no longer advertises migration or rollback.

## Non-goals

- Migrating or reconstructing any retired agent.
- Changing canonical profile schema, runtime policy, private homes, credentials, transcripts or memory.
- Removing inline terminal definitions or generic YAML editing for commands, runbooks and schedules.
- Implementing per-agent plugins or runtime-native memory.
- Removing historical shipped specs; they remain immutable evidence and may describe past migration.

## Open questions

None. The maintainer confirmed the legacy `codex` agent has been removed and authorized this cleanup.

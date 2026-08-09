# 416 — adhoc-postmortem-retention

_Created 2026-07-19. Task: t-1e636f._

**Status:** shipped

**Closure:** Shipped 2026-07-19 in `b734ca97`. Clean-exited ad-hoc rows now persist a terminal lifecycle marker across manager reconstruction, are excluded from generic resume planning, remain explicitly dismissible, and retain authenticated coordinator authority for managed child-worktree cleanup. Dogfood, focused verification, typecheck, and the 5,102-test full suite passed headlessly.
**Verify:** `npx vitest run test/unit/agentManager.test.ts test/unit/bridge.test.ts test/unit/resume.test.ts test/unit/managedWorktree.test.ts --maxWorkers=1`
**Verify:** `npm run typecheck`
**Dogfood:** `npx vitest run test/unit/agentManager.test.ts test/unit/managedWorktree.test.ts -t "postmortem across manager reload|coordinator retains authority" --maxWorkers=1`

## Intent

Clean-exited ad-hoc agents are meant to remain as explicit postmortem rows until `dismiss_agent`, but the current lifecycle deletes their session-ledger row as soon as `AgentManager.list()` observes exit code 0. The row survives only in process-local maps. An engine restart/rebind therefore loses the row while leaving its transcript and managed worktree behind, breaking `list_agents`, `read_output`, evidence attachment and coordinator cleanup.

Persist a bounded terminal lifecycle marker in the existing session ledger. A clean exit must keep the restart definition, lineage, worktree record and durable transcript reachable without becoming an automatic resume candidate. Explicit dismiss remains the sole normal end-of-life operation. For Tachyon-created agent worktrees, the authenticated coordinator that spawned the agent must remain recorded as creator so it can remove the stopped child's checkout after reviewing it.

Affected Product Invariants: none — this repairs lifecycle retention and cleanup authority without changing a registered product promise.

## Acceptance criteria

- [x] **Scenario: clean exit survives engine reconstruction**
  - **Given** an ad-hoc agent with a persisted session row and durable transcript
  - **When** it exits with code 0, its pane is cleared, and a new `AgentManager` rehydrates the ledger
  - **Then** `list_agents` still exposes one stopped `cleanExited` row with postmortem output and dismiss capability
- [x] **Scenario: terminal row never auto-resumes**
  - **Given** a clean-exited lifecycle marker on a resumable ad-hoc record
  - **When** activation computes its resume plan
  - **Then** it produces no reattach, auto-resume or offer action for that record
- [x] **Scenario: explicit dismiss is final**
  - **Given** a rehydrated clean-exited ad-hoc row
  - **When** `dismiss_agent` succeeds
  - **Then** the row, lifecycle marker, durable transcript/activity footprint and worktree ownership handle are removed through the existing explicit cleanup paths
- [x] **Scenario: a new incarnation clears terminal state**
  - **Given** a previously clean-exited ad-hoc record
  - **When** the human explicitly restarts or respawns it
  - **Then** the new live record no longer carries `clean-exited` lifecycle state
- [x] **Scenario: authenticated coordinator can clean child worktree**
  - **Given** an agent worktree created for a Bridge-authenticated delegated spawn
  - **When** the child has stopped and its coordinator calls `remove_worktree`
  - **Then** ownership permits that coordinator while still refusing unrelated agents and preserving dirty/occupancy guards
- [x] Malformed persisted lifecycle values are ignored safely and never create a postmortem row.
- [x] Existing pre-marker session rows retain their prior resume/restart behavior.

## Non-goals

- Changing crash/non-zero-exit retention or Delivery lease recovery.
- Granting arbitrary agents peer-worktree removal authority.
- Auto-removing postmortem rows or adding a retention timeout.
- Persisting the in-memory bounded tail itself; the existing durable pane transcript remains the restart-safe output source.
- Changing UI layout or adding a new Bridge tool.

## Open questions

None. The task already establishes explicit-dismiss retention; authenticated Bridge caller identity supplies the coordinator authority without trusting a client-declared parent.

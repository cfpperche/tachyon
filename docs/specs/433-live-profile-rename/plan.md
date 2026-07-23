# 433 — Live canonical profile rename — plan

_Drafted from `spec.md` on 2026-07-22._

## Approach

Extend `AgentProfileRenameJournal` with an optional serializable live snapshot captured while both profile locks are held and before the home move. `AgentManager` supplies a prepare method that rejects unsupported runtimes and records whether the exact tmux session, ledger row and activity files exist. The persistent profile/authority/YAML/Evolution sequence remains the commit boundary from SDD 432.

After Evolution convergence, call an idempotent live convergence method before activation and journal removal. Tmux uses exact old/new existence pairs. `SessionLedger` gains one atomic rename operation that moves the expected row and rewrites child lineage/delegator references in one file replacement. Activity files capture source provenance and destination absence, then use no-overwrite pair-state rename; this deliberately permits the live writer to append between intent and convergence. In-memory lineage, postmortem and runtime indexes synchronize only after durable states pass; terminal presentation stays a Workspace concern and reopens after commit.

Startup recovery passes the same AgentManager live port into SDD 432 reconciliation. It can acknowledge a step already completed before an interruption and refuses ambiguous ownership.

## Key decisions

- **Reuse the SDD 432 journal and two-name locks** — a second transaction could disagree about which name owns the runtime.
- **Persist only durable ownership evidence** — terminal tabs, pending-anchor flags and incarnation maps are process caches and move after commit.
- **Add narrow prepare/converge APIs** — legacy `AgentManager.rename()` remains the compatibility path, not a black box inside recovery.
- **Preserve harness/Pi refusal before mutation** — their name-keyed private homes need dedicated support.

## Files touched

- `src/config/agentProfileRename.ts` — live snapshot/phase and recovery callback.
- `src/agents/AgentManager.ts` — prepare and idempotent convergence primitives.
- `src/resume/SessionLedger.ts` — atomic exact rename plus child-reference rewrite.
- `src/activity/logStore.ts` — exact activity pair-state move.
- `src/workspace/Workspace.ts` — running profile route and presentation cache convergence.
- Focused unit and headless composition tests.

## Risks & unknowns

- Tmux rename has no transaction; recovery must inspect both exact session names after every uncertain result.
- The ledger currently writes in place. This slice must make replacement crash-safe before treating it as a durable step.
- Activity writers rekey from the atomically moved ledger; their final old-name poll rechecks ledger ownership before writing.

## Visual impact

None. An already-open terminal is reattached under the new name, but no UI design changes.

## Sources consulted

- SDDs 431 and 432.
- `AgentManager.rename`, `SessionLedger`, `activity/logStore`, `Workspace.renameAgent` and terminal presentation seams.
- Architecture probe `probe-58b1346f-3728-4069-9c4d-6a5adf909f96`.

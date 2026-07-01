# 307 — adhoc-nudge-policy — plan

_Drafted from `spec.md` on 2026-06-30. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add one runtime-neutral policy gate for automatic persistence nudges and wire every proactive continuity/project-handoff path through it. The policy should answer a narrow question: "may Tachyon proactively type persistence reminders into this agent session?" It should not decide whether Activity exists, whether manual commands are available, or whether Bridge tools may write state.

The first implementation should be conservative:

1. Treat declared agents as eligible for automatic persistence nudges.
2. Treat every ad-hoc session as ineligible by default, including fork/worktree ad-hoc rows.
3. Keep explicit Bridge writes allowed because they are writes requested by the calling tool.
4. Keep the human UI reinject-continuity action allowed for ad-hoc sessions, but do not let a generic/programmatic `"manual"` transition bypass the automatic-nudge policy.

This keeps the behavior independent of runtime strings. Codex and Claude are covered because both go through `Workspace.recoverOnIdle(...)`, `injectContinuity(...)`, `maybeRemindCheckpoint(...)`, and `maybeRemindHandoff(...)` after `AgentManager.kindOf(agent) === "agent"` has classified them as AI agents.

## Key decisions

- **Gate automatic persistence nudges, not persistence tools** — chosen because the bug is unsolicited typing into ephemeral children; rejected blocking `set_continuity`/handoff tools because explicit writes are intentional and are already useful for supervised delegation.
- **Use Tachyon durability, not runtime name** — chosen because the same policy should apply to Codex, Claude, and future runtimes; rejected runtime-specific allow/deny lists because they would miss the next adapter.
- **Default-off for plain ad-hoc** — chosen because Bridge-spawned review/probe children are often temporary and should not be nagged into durable project state; rejected default-on because the screenshot proves it creates visible noise.
- **Keep fork/worktree ad-hoc ineligible in v1** — chosen after Claude review because fork/worktree are isolation/durability mechanics, not an explicit "please nudge this session into project persistence" signal; rejected deriving nudge policy from ledger worktree/fork because it conflates unrelated concerns.
- **No schema/config change in v1** — chosen because existing ledger metadata is enough for the current bug; rejected new user config until a real opt-in surface is needed.

## Files touched

- `src/workspace/Workspace.ts` — add/use a helper that suppresses automatic continuity and project-handoff reminders for plain ad-hoc agents.
- `src/agents/AgentManager.ts` or a small pure helper module — expose/reuse enough ledger durability information for the policy without runtime branching.
- `src/extension.ts` — pass an explicit UI origin for the manual reinject-continuity command.
- `src/sidebar/actions.ts` — likely unchanged; manual reinject-continuity remains visible because the command path carries UI origin.
- `test/unit/continuityWiring.test.ts` or a new workspace nudge-policy test — prove plain ad-hoc Codex and Claude children stay quiet while declared agents still receive automatic continuity nudges.
- `test/unit/projectHandoff*.test.ts` or a new workspace nudge-policy test — prove plain ad-hoc children do not receive automatic handoff reminders while durable agents still do.
- `docs/specs/307-adhoc-nudge-policy/notes.md` — record Claude plan review and any changed decisions.

## Risks & unknowns

- `maybeRemindCheckpoint(...)` is currently private and called from idle recovery; tests may need to use `recoverOnIdle(...)` with fakes or call the private method through a test cast. Prefer the public path if it remains readable.
- `injectContinuity(agent, "manual")` must not become a generic bypass. Only the UI command should pass the UI origin that allows manual reinjection.
- Role re-anchor currently runs before continuity recovery. This spec keeps it out of scope: re-anchor is role reminder behavior, not a persistence/handoff nudge. If ad-hoc re-anchor proves noisy, it should get its own policy spec instead of being hidden inside this one.
- Existing dirty work for spec 306 must stay isolated from this spec.

## Sources consulted

- `src/workspace/Workspace.ts` — `recoverOnIdle`, `injectContinuity`, `maybeRemindCheckpoint`, `maybeRemindHandoff`.
- `src/agents/AgentManager.ts` — ledger records, `declared`, `def.fork`, `worktree`, ad-hoc lifecycle.
- `src/sidebar/actions.ts` — manual `reanchor` and `reinjectContinuity` action availability.
- `test/unit/continuityWiring.test.ts` — existing headless continuity wiring coverage.
- `test/unit/probeBridge.test.ts` and `src/probe/*` — probe/ad-hoc lane exists separately from persisted agents.
- Prior shipped specs 241/245/246/257 by code reference: continuity injection, project handoff, spawn contracts, and headless probes.
- Claude probe `probe-36c17d66-72a1-4349-aaca-b93004d10b38` — plan review verdict `NEEDS-REVISION`; accepted changes: no fork/worktree heuristic, no generic manual bypass, single shared predicate.

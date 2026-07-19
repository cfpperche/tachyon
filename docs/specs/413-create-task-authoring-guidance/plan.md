# 413 — create-task-authoring-guidance — plan

_Drafted from `spec.md` on 2026-07-19. The approach, not the steps (those go in `tasks.md`)._

## Approach

Centralize Task authoring maxima and bounded domain messages in a small task-layer module. TaskStore consumes those limits defensively. `create_task` keeps native Zod `.max(...)` checks, but gives each bounded field a local error map that computes the received code-point/entry count; this preserves canonical `maxLength`/`maxItems` in the MCP schema while replacing generic failures before the handler mutates state.

Expand the tool description into a compact authoring contract: a Task is one bounded schedulable work unit; four independently shippable slices become an umbrella plus explicit follow-ups; execution history belongs in `append_task_note`; long material belongs in a durable artifact referenced by `artifact_refs`. Tests exercise the real MCP boundary and direct store boundary.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Field-local Zod error maps retain native `.max` checks** — chosen because the MCP SDK still advertises canonical bounds and rejects before the handler; rejected permissive transport schemas plus handler validation because their JSON schema would lie about the domain limit.
- **Shared limits and message builder, separate enforcement** — chosen because MCP and TaskStore have different trust boundaries but must not drift; rejected routing all validation through the handler because non-MCP callers still need defensive storage checks.
- **Guidance only, no orchestration side effect** — chosen because decomposition requires author judgment; rejected automatic follow-up creation and dependency inference because an invalid call must be atomic and policy-free.

## Files touched

- `src/tasks/taskAuthoring.ts` — canonical create-task maxima, received-size helpers, and bounded domain messages.
- `src/tasks/TaskStore.ts` — consume canonical limits and domain errors at the storage boundary.
- `src/bridge/tools.ts` — field-local Zod errors and the authoring/decomposition contract.
- `test/unit/bridge.test.ts` — real MCP failures, JSON-schema bounds, guidance, and no-side-effect proof.
- `test/unit/taskStore.test.ts` — direct defensive limit/atomicity proof.
- `docs/specs/413-create-task-authoring-guidance/*` — intent, design, checklist, and evidence.

## Risks & unknowns

- A refinement-only Zod schema could erase `maxLength`; retain `.max` and assert the listed tool schema.
- JavaScript string length counts UTF-16 code units; use code-point counts so messages agree with TaskStore.
- Error prose could grow without bound or accidentally echo user content; interpolate only field name and numeric counts, then assert a response cap and secret non-echo.

## Visual impact

None. This is an MCP text/error contract with no rendered UI change.

## Sources consulted

- `src/bridge/tools.ts` (`create_task`, `append_task_note`, `TASK_ARTIFACT_REF`)
- `src/tasks/TaskStore.ts` (`create`, `boundedString`, `optionalArtifactRefs`)
- `test/unit/bridge.test.ts` real in-memory MCP client coverage
- `docs/specs/325-task-queue-entity/` original Task queue contract

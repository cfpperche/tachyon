# 299 — managed-entry-taxonomy — notes

_Created 2026-06-30._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Initial research confirmed the user concern: config/docs already distinguish AI agents from terminals, but core names still use `agent` as the umbrella. Evidence: `TachyonConfig.agents` is the merged map; `AgentManager.list()` returns both kinds; MCP exposes `list_agents` for both.
- Use `ManagedEntry` as the working umbrella term. `session` stays reserved for tmux/runtime resume contexts.
- Use a Claude ad-hoc agent for review, not the persistent `claude` agent, per user request.
- Claude ad-hoc review accepted: make `ManagedEntryDef` canonical rather than cosmetic; keep `AgentDef`/`AgentInfo` as compatibility aliases only; do not add `list_entries`/`spawn_entry` MCP aliases in v1; explicitly freeze VS Code command IDs for this release.

## Accepted debt

- `AgentManager` as a class name and `config.agents` as the merged config map can remain legacy compatibility names in this release. The spec's goal is to stop spreading the wrong umbrella and create canonical neutral types/docs, not to rename every public or high-churn symbol at once.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

- 2026-06-30: `npm test -- --run test/unit/config.test.ts test/unit/agentManager.test.ts test/unit/sidebarActions.test.ts test/unit/bridge.test.ts && npm run -s typecheck` passed. Vitest: 4 files, 210 tests.

### 2026-06-30T16:37:32Z — pass (1/1) — source: tasks.md
- `npm test -- --run test/unit/config.test.ts test/unit/agentManager.test.ts test/unit/sidebarActions.test.ts test/unit/bridge.test.ts && npm run -s typecheck` — pass

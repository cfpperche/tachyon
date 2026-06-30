# 299 — managed-entry-taxonomy — plan

_Drafted from `spec.md` on 2026-06-30. The approach, not the steps (those go in `tasks.md`)._

## Approach

Implement this as an incremental terminology migration, not a big-bang rename. The first slice should make the domain model honest while leaving all public contracts compatible.

1. Introduce neutral internal names around the unified config/listing concept: `ManagedEntryDef`, `ManagedEntryInfo`, and related helper names. Make the neutral names canonical where practical, with existing exports (`AgentDef`, `AgentInfo`, `AgentManager`) preserved as compatibility names unless a narrow rename is obviously local.
2. Update comments, docs, and UI model comments that currently say terminals are "non-AI agents" or that `agent` means "managed entry".
3. Keep `EntryKind = "agent" | "terminal"` unchanged. This is the correct AI-vs-terminal taxonomy.
4. Avoid using `session` as the umbrella term. Use `tmux session` for tmux lifecycle, `runtime session` or `conversation session` for resume/transcript identity, and `managed entry` for the Tachyon-owned row.
5. Treat Bridge/MCP names as public API. V1 does not add neutral tool aliases; existing tools are documented as compatibility names whose results include both `agent` and `terminal` kinds.
6. Run tests around config parsing, Agent Studio, sidebar actions, Bridge tools, manager lifecycle, and i18n/docs where applicable.

## Key decisions

- **Do not rename the umbrella to `session`** — chosen because Tachyon already uses session for tmux sessions and runtime resume/conversation IDs; rejected a pure `sessions:` rename because it would trade one ambiguity for another.
- **Keep `agent | terminal` as the kind taxonomy** — chosen because the existing parser, UI grouping, attention defaults, and docs already use this split correctly; rejected new kind names because they do not solve the umbrella naming debt.
- **Prefer `ManagedEntry` for the unified config/list row** — chosen because it covers both AI agents and terminals without implying process-only lifecycle; rejected `Agent` as too broad and `ManagedProcess` as too narrow for config metadata. The neutral name should become canonical where practical, with `AgentDef` / `AgentInfo` as compatibility aliases.
- **Preserve public compatibility first** — chosen because `spawn_agent`, `list_agents`, command IDs, docs, and existing `tachyon.yml` files are user-facing contracts; rejected a breaking rename as too costly for a terminology cleanup.
- **Do not add MCP aliases in v1** — chosen because additive names such as `list_entries` would become permanent public surface while the old names must remain; rejected alias expansion until there is a deliberate API-version/deprecation plan.
- **Use aliases before file moves** — chosen because the blast radius is large (`AgentManager`, `config.agents`, sidebar VMs, MCP schemas, tests); rejected a wholesale directory rename as likely to create churn without behavior value.

## Files touched

- `src/config/loadConfig.ts` — introduce neutral managed-entry type aliases and clarify `TachyonConfig.agents` as compatibility storage for merged entries.
- `src/agents/AgentManager.ts` — introduce neutral info/options aliases and update comments/error text where "agent" means any managed entry.
- `src/bridge/tools.ts` — preserve existing MCP tools and improve descriptions; do not add neutral alias tools in v1.
- `src/sidebar/types.ts`, `src/sidebar/agentModel.ts`, `src/webview/sidebar/App.tsx` — update internal comments/types where terminals are described as agents.
- `src/presentation/Terminals.ts`, `src/tmux/TmuxService.ts` — clarify `entryName` vs tmux `session`.
- `README.md`, `docs/system-design.md`, relevant specs — update conceptual docs to stop using agent as the umbrella term.
- `package.nls.json`, `l10n/bundle.l10n.pt-br.json` — only if user-visible command/notification strings are adjusted.
- Unit tests under `test/unit/` — preserve behavior while accepting the neutral names.

## Risks & unknowns

- MCP clients may cache tool schemas by name, so any neutral alias must be additive and existing names must remain.
- `session` is attractive because tmux uses that word, but Tachyon already has resume/session-ledger semantics; docs must explicitly disambiguate.
- Type aliases can become cosmetic if the implementation does not also remove misleading comments and docs.
- Renaming command IDs such as `tachyon.openAgentTerminal` would be a breaking VS Code contribution change; explicitly out of scope for this release.
- Some historical specs intentionally use old terms; update current docs/code comments, not all historical records.

## Sources consulted

- `README.md` § "Agents vs terminals — the kind taxonomy": current public explanation and the explicit "read agent as managed entry" debt.
- `src/config/loadConfig.ts`: `EntryKind`, `AgentDef`, `TachyonConfig.agents`, and merge of `agents:` / `terminals:`.
- `src/agents/AgentManager.ts`: `AgentInfo`, `session(name)`, `kindOf`, `list`.
- `src/bridge/tools.ts`: public MCP tool names and descriptions.
- `src/tmux/TmuxService.ts`: tmux `sessionName` / `agentFromSession` naming.
- `src/presentation/Terminals.ts`: editor terminal attachment semantics.
- `docs/specs/194-tachyon-sidebar-taxonomy/` and `docs/specs/215-tachyon-terminals-block/`: prior decisions that introduced kind taxonomy and the `terminals:` block.

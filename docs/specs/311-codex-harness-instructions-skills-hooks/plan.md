# 311 — codex-harness-instructions-skills-hooks — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a Codex-specific `harness.instructions` field while preserving existing Claude `harness.rules`.
`instructions` is parsed as a workspace-relative file path or list of paths, like rules/skills, but only materializes
for Codex. During materialization Tachyon concatenates those files into the private `CODEX_HOME/AGENTS.md` with section
headers.

Allow `harness.skills` for Codex and copy each workspace skill directory into `CODEX_HOME/skills/<basename>`, the user
skill location that `codex debug prompt-input` demonstrated as visible in the skills list. Keep the existing fail-closed
checks: source must stay under the workspace, contain `SKILL.md`, and use unique basenames.

Allow `harness.hooks` for Codex and write it into `config.toml` using the native top-level `hooks` TOML table shape.
This is structural materialization in this pass; hook firing is left to manual dogfood because a reliable headless hook
trigger would require driving a real Codex lifecycle event.

## Key decisions

- **Use `instructions`, not `rules`, for Codex** — chosen because Codex's native durable guidance is `AGENTS.md`;
  rejected reusing `rules` because it would imply Claude parity and the wrong destination.
- **Copy skills into `CODEX_HOME/skills`** — chosen because local `codex debug prompt-input` listed a skill there;
  rejected repo `.agents/skills` for harness isolation because it would mutate the shared workspace.
- **Write hooks into `config.toml`** — chosen because Codex config reference exposes native `hooks.<Event>`;
  rejected Claude `settings.json` because Codex does not read that surface.
- **Keep `mcp` optional once another Codex harness capability is present** — chosen because instructions/skills/hooks
  are legitimate isolated capabilities; rejected requiring MCP forever because the expanded harness would be unusable
  for a pure instruction/skill agent.

## Files touched

- `src/config/loadConfig.ts` — parse/validate `harness.instructions`, allow Codex skills/hooks, keep Codex rules rejected.
- `src/harness/HarnessManager.ts` — materialize Codex `AGENTS.md`, skills, and hooks in private `CODEX_HOME`.
- `src/webview/formLogic.ts` / `src/webview/agent-studio/App.tsx` / strings — expose Codex instructions/skills/hooks honestly in Agent Studio.
- `test/unit/config.test.ts`, `test/unit/harness.test.ts`, `test/unit/agentStudio.test.ts` — regression coverage.
- `docs/specs/311-codex-harness-instructions-skills-hooks/*` — SDD artifacts and evidence.

## Risks & unknowns

- Hook execution may require trust/feature state in a real TUI. We verify native config shape headlessly and mark real
  hook firing as manual dogfood.
- TOML writing must not destroy existing workspace config when `inherit: workspace` is enabled.
- `instructions` should not trample user-authored files outside Tachyon's private `CODEX_HOME`.

## Sources consulted

- Local `codex --help`, `codex mcp --help`, and `codex debug prompt-input`.
- OpenAI Codex docs: Agent Skills, AGENTS.md custom instructions, Config Reference / Hooks.
- `docs/specs/298-codex-isolated-harness/*` — existing Codex MCP/config/transcript harness.
- `src/harness/HarnessManager.ts`, `src/config/loadConfig.ts`, `src/plugins/adapters/codex.ts`.

# 303 — codex-project-handoff-nudge — plan

_Drafted from `spec.md` on 2026-06-30._

## Approach

Reuse the existing spec-243/spec-245 hook scripts instead of creating a second handoff mechanism. `SESSION_OWNER_RECORDER_SOURCE` already understands the hook payload fields Codex sends (`session_id`, `transcript_path`, `cwd`, `source`), and `SESSION_HANDOFF_POINTER_SOURCE` already emits the one-line Project Handoff pointer. The new runtime-specific part is only injection: Claude keeps its per-spawn `--settings` file; Codex gets a session-scoped `-c hooks.SessionStart=...` config override inserted immediately after the `codex` binary.

The Codex hook command uses `TACHYON_AGENT_NAME` from the process env instead of baking the agent name into the command. This keeps the generated hook command stable across agents in a workspace and still gives the recorder exact per-agent attribution. Tachyon does not edit `.codex/hooks.json`; local smoke proved the `-c` hook merges with project hooks.

## Key decisions

- **Inject Codex SessionStart via `-c hooks.SessionStart=...`** — chosen because it is session-scoped and additive; rejected editing `.codex/hooks.json` because it is user/workspace-owned and can already contain plugin hooks.
- **Reuse the existing recorder and handoff pointer scripts** — chosen because Codex hook stdin has the same fields those scripts need and Codex accepts `hookSpecificOutput.additionalContext`; rejected a Codex-only pointer because it would duplicate behavior and drift.
- **Pass agent identity through `TACHYON_AGENT_NAME`** — chosen because it avoids per-agent command-string churn while preserving exact attribution; rejected hardcoding the agent name in the Codex hook command because it would create a distinct hook trust hash per agent.
- **Do not add `--dangerously-bypass-hook-trust`** — chosen because Tachyon should not bypass all enabled hooks for a user's session; trust remains Codex's normal runtime contract.

## Files touched

- `src/activity/sessionOwners.ts` — build a Codex-compatible `hooks.SessionStart` override using the existing recorder/pointer scripts.
- `src/harness/HarnessManager.ts` — materialize shared hook scripts and return the Codex override string.
- `src/agents/AgentManager.ts` — inject Codex session hooks with `-c`; set `TACHYON_AGENT_NAME` in spawn/resume env.
- `src/workspace/Workspace.ts` — wire the materializer with the real Project Handoff path.
- Unit tests — cover pure config construction, materialization, spawn command/env behavior, and Codex config insertion.

## Risks & unknowns

- Codex hook trust may prompt the user the first time a generated hook hash is seen. This spec must not paper over that with `--dangerously-bypass-hook-trust`.
- The exact Codex hook schema is runtime-owned. We prove against the installed local `codex-cli 0.142.4` and keep the injected shape minimal.
- `TACHYON_AGENT_NAME` is agent env; a user could override it in `tachyon.yml`. The existing env merge order lets agent-declared env win, so tests should keep the normal path honest and documentation can call out the footgun if it becomes real.

## Sources consulted

- Pin `p-b26617` (`.tachyon/pins/p-b26617.json`) and attachment showing A4 follow-up.
- `src/agents/AgentManager.ts` lines around `withSessionOwnership` and spawn/resume command construction.
- `src/activity/sessionOwners.ts` existing recorder and handoff pointer scripts.
- `src/harness/HarnessManager.ts` existing Claude `--settings` materialization.
- `test/unit/agentManager.test.ts` existing explicit Codex non-injection test.
- Local `codex --help`, `codex features list`, and `codex doctor` for installed Codex CLI `0.142.4`.
- Local hook smokes proving Codex `SessionStart` visibility, `-c` merge behavior, and `hookSpecificOutput.additionalContext` support.

# 315 — persistence-stop-hook-dogfood — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Use the real Tachyon sidebar Stop/Resume path as the primary dogfood because this spec is about persisted agents, not only
runtime hook syntax. Treat headless probes as supporting evidence only: they may prove a runtime event exists, but they can
miss trust, tmux, and TUI lifecycle behavior.

The dogfood is evidence-driven:

1. Confirm hook injection state for the persisted agent (`.tachyon/activity/silent-persistence-hooks.json`).
2. Stop/resume the real persisted agent from the sidebar.
3. Inspect `.tachyon/activity/persistence-stop.jsonl` for a row from that exact agent.
4. Inspect `.tachyon/activity/persistence-hooks-failures.jsonl` for hook-script failures.
5. If the row is missing, isolate the runtime contract with a minimal `codex exec` or Claude probe before calling it a
   Tachyon bug.

## Key decisions

- Manual persisted-agent dogfood is required for both runtimes.
- A headless command is acceptable as a regression check only after the real path is understood.
- Do not add `--dangerously-bypass-hook-trust` to normal Codex agents as a shortcut: it is broader than Tachyon's generated
  hooks and can also bypass trust for project/user hooks.

## Files touched

- `docs/specs/315-persistence-stop-hook-dogfood/spec.md`
- `docs/specs/315-persistence-stop-hook-dogfood/plan.md`
- `docs/specs/315-persistence-stop-hook-dogfood/tasks.md`
- `docs/specs/315-persistence-stop-hook-dogfood/notes.md`
- Possible code follow-up: Codex hook trust handling or explicit unsupported-state reporting.

## Risks & unknowns

Highest risk: claiming Stop success without proving the runtime fired the hook. The July 1 dogfood found exactly this trap:
Codex SessionStart hooks were active and current, but no Codex Stop row appeared.

Second risk: the easy fix (`--dangerously-bypass-hook-trust`) is too broad for normal agents because it would affect
unrelated hooks loaded from user/workspace config.

## Sources consulted

- `docs/specs/312-silent-persistence-hooks/`
- `docs/specs/314-persistence-hooks-v2/`
- `src/activity/sessionOwners.ts`
- `src/harness/HarnessManager.ts`
- `src/agents/AgentManager.ts`
- `src/workspace/Workspace.ts`
- `src/config/loadConfig.ts`
- `~/.codex/config.toml` hook trust state for `/<session-flags>/config.toml`

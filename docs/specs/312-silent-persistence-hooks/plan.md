# 312 — silent-persistence-hooks — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Use the existing per-spawn hook injection path as the delivery mechanism:

- Claude already receives a generated `--settings <file>` layer for Tachyon-owned `SessionStart` activity ownership.
- Codex already receives a generated `-c hooks.SessionStart=...` override for Tachyon-owned `SessionStart` activity ownership.

Extend that generated hook payload into a small "persistence hook bundle" for persisted agents only. The bundle should
reuse the same materialized script directory under `.tachyon/activity` or a new `.tachyon/hooks` directory, and should be
rewritten on spawn/restart/resume so paths and agent names are fresh.

Event mapping:

- `SessionStart` with matchers `startup|resume|clear|compact`: rehydrate continuity silently by printing
  runtime-native `additionalContext` or plain text that the runtime treats as context.
- `Stop`: perform deterministic handoff/checkpoint bookkeeping after a turn. In v1 this should write durable state and
  never force a visible continuation or invent semantic handoff notes.
- `PreCompact`/`PostCompact`: follow-pass unless needed for correctness after review. They are good lifecycle hooks, but
  `SessionStart(compact)` may cover the rehydrate half with less surface.
- `UserPromptSubmit`: fallback for last-moment context injection, not the primary mechanism, because it runs every human
  prompt and can become expensive/noisy internally.

Disable or bypass the existing visible `maybeRemindCheckpoint` / `maybeRemindHandoff` pane nudges when silent hooks are
available for the agent. Keep a conservative fallback only if hook materialization is unavailable.

## Key decisions

- **Persisted agents only** — chosen because they have stable definitions and lifecycle ownership; rejected ad-hoc default
  hooks because spec 307 established ad-hoc persistence should be opt-in.
- **Use `SessionStart` for continuity rehydrate** — chosen because both Claude and Codex support startup/resume/clear/compact
  semantics and context injection; rejected pane typing because it is the user-visible problem.
- **Use `Stop` for handoff bookkeeping** — chosen because it fires at end-of-turn when a handoff note can be considered;
  rejected `PostToolUse` as the primary path because it can run too often and before the turn's intent is clear. V1
  bookkeeping is cursor/health only; semantic handoff content stays explicit through `append_project_handoff_note`.
- **Additive hook injection** — chosen because Tachyon must not take over user hooks; rejected writing to shared user/project
  hook files as default because it would be surprising and harder to cleanly remove.
- **Fallback is explicit** — chosen because if hooks are unavailable, visible nudges should not silently come back as spam;
  rejected automatic fallback to pane nudges without a clear setting.

## Files touched

- `src/agents/AgentManager.ts` — gate hook injection to persisted agents and route persistence hook config into spawn/resume.
- `src/harness/HarnessManager.ts` or a new persistence hook module — materialize Claude/Codex hook scripts/config.
- `src/activity/sessionOwners.ts` or new `src/persistence/*` — shared hook script builders for continuity context and
  deterministic handoff/health actions.
- `src/workspace/Workspace.ts` — disable visible persistence nudges when silent hook support is active.
- `test/unit/agentManager.test.ts`, `test/unit/harness.test.ts`, continuity/handoff tests — regression coverage.
- `docs/specs/312-silent-persistence-hooks/*` — SDD artifacts and review notes.

## Risks & unknowns

- Codex hook trust may block non-managed command hooks unless reviewed. For generated per-agent hooks, verify whether
  session-scoped `-c` hooks need trust and whether `--dangerously-bypass-hook-trust` is acceptable or not.
- Claude and Codex differ in hook output shape. Do not assume one JSON payload works for both without tests.
- `Stop` hooks can accidentally create loops if they ask the runtime to continue. V1 should write state only.
- Hook scripts run on runtime lifecycle; they must be fast, deterministic, and non-throwing.
- If hook materialization fails, the user experience should be quiet and observable, not a return to spam.
- A hook being installed is not the same as a hook working. Tests should cover generated config shape, and dogfood should
  prove at least one runtime receives silent context.

## Sources consulted

- Claude hooks docs: `SessionStart`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `Stop`, `SessionEnd`, additive settings hooks.
- Codex hooks docs: `SessionStart`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `Stop`, inline `config.toml`/`hooks.json`, `additionalContext`.
- `src/agents/AgentManager.ts` — current `withSessionOwnership` hook injection for Claude/Codex.
- `src/activity/sessionOwners.ts` — current generated ownership hook scripts.
- Specs 303, 307, 309, 311 — Codex hooks, ad-hoc persistence policy, nudge spam fix, Codex harness hooks.

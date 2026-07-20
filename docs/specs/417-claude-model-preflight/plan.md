# 417 — claude-model-preflight — plan

_Drafted from `spec.md` on 2026-07-19. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a first-class `provisional` preflight result and a narrow Claude adapter. The adapter does not probe a catalog and does not return `supported` for explicit models; it states that validation is delegated to Claude's bounded startup-readiness boundary. Register it next to the Codex authoritative adapter. `AgentManager` already proceeds for non-error results, observes Claude readiness, rejects classified model failures, and keeps pending launches unassignable.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Typed provisional state, not an exception allowlist** — keeps capability truth in the runtime adapter and makes it impossible to confuse startup validation with catalog support.
- **Use the actual runtime startup as the authority** — Claude exposes no bounded account-aware catalog command, while its CLI owns aliases/full ids and already validates them before presenting the measured composer. Rejected a Tachyon-owned alias list because it would drift and could not prove entitlement.
- **Keep fail-closed as the registry default** — only Claude gets the explicit startup-validation adapter; missing adapters remain `unverifiable`.

## Files touched

- `src/runtime/launchPreflight.ts` — add the honest provisional result to the runtime-neutral contract.
- `src/runtime/adapters/claudeLaunchPreflight.ts` — map literal Claude commands into default-supported or explicit-model provisional results.
- `src/agents/AgentManager.ts` — register the Claude capability adapter.
- `test/unit/runtimeLaunchPreflight.test.ts` — adapter/registry/fail-closed contract tests.
- `test/unit/agentManager.test.ts` — delegated Claude success and startup-rejection lifecycle regressions.

## Risks & unknowns

- A provisional launch may outlive the five-second window; this is safe because it remains `starting` and assignment/input gates re-observe readiness.
- Fatal output wording can drift; process exit and measured composer are independent signals, and classifier evolution remains owned by launch readiness.

## Visual impact

None. Bridge result semantics reuse existing `ready` / `starting` / structured readiness rejection output.

## Sources consulted

- `docs/specs/370-runtime-launch-preflight/` ratified catalog honesty, bounded readiness, compensation, and fail-closed defaults.
- Claude Code 2.1.215 local `--help` documents runtime-native aliases and full ids but exposes no catalog command.
- `src/runtime/launchReadiness.ts` and the measured Claude composer profile supply the startup-validation boundary.

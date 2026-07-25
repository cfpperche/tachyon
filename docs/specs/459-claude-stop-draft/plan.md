# 459 — claude-stop-draft — plan

_Drafted from `spec.md` on 2026-07-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

Extend the graceful-stop step model with a conditional literal-text step, use it only for Claude
after the existing interrupt/clear actions, and exercise the exact emitted tmux input in the
AgentManager unit fake. Preserve the profile's partial-verification status.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Use `/exit` after clear** — measured in a real no-prompt Claude TTY; rejected Ctrl+D retry because
  it left the live pane running.
- **Keep `verified: false`** — draft behavior is measured, but active-turn behavior has no non-billable
  evidence.

## Files touched

- `src/runtime/runtimeProfile.ts` — Claude's measured sequence and richer step shape.
- `src/agents/AgentManager.ts` — conditional text delivery to the live TUI.
- `test/unit/{agentManager,runtimeProfile}.test.ts` — exact sequence and profile assertions.

## Risks & unknowns

Literal text must be sent only when the pane is still live and must submit as a TUI command, not a
shell command. The test fake records both literal input and Enter.

## Visual impact

No rendered product surface changes.

## Sources consulted

- `docs/specs/455-claude-canonical-parity/`
- `src/runtime/runtimeProfile.ts`
- `src/agents/AgentManager.ts`

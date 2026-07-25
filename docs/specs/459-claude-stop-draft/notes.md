# 459 — claude-stop-draft — notes

_Created 2026-07-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- The private-home probe stopped at onboarding because it deliberately had no copied credentials.
  The authenticated profile was used only to observe a blank TUI, an unsubmitted draft, and local exit;
  no model prompt was submitted.
- `--settings '{"permissions":{"defaultMode":"plan"}}'` rendered plan mode, while an explicit
  `--permission-mode auto` rendered auto mode. CLI wins over settings for this observed mode.

## Verification log

- Focused `agentManager` and `runtimeProfile` tests passed before the final full gates.
- `npm run typecheck` and `npm run verify:full:quiet` passed after the stop-sequence change.
- With approval `a-eca2e7`, one Claude Code 2.1.220 no-tools prompt was started in an isolated tmux
  session. Escape, Ctrl+C, then `/exit` produced `Pane is dead (status 0)` on 2026-07-25.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

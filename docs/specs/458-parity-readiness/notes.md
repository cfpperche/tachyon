# 458 — parity-readiness — notes

_Created 2026-07-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Runtime profiles carry only limitation codes already established by the parity slices; adapter-native fork
  support is queried at projection time so it cannot drift from the actual resume adapter.

## Visual QA

- `npm run build` produced `dist/webview/agent-studio-fixture.js` for the canonical-disabled preview.
- The configured browser capture could not start: the worktree has no provisioned agent-browser launcher
  (`BROWSER_RUNTIME_MISSING`). This is recorded as `unable_to_judge`, not as a visual pass.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

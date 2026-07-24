# 445 — bridge-idle-stream-attention — notes

_Created 2026-07-24._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Request kinds are content-free and closed: `mcp-tool`, `mcp-stream`,
  `mcp-session`, `mcp-protocol`, `other`.
- Only `mcp-tool` is actionable enough to enter the extreme-slow warning policy.
  All kinds still update duration and slow-request metrics.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

None.

## Verification log

- Focused: 75 tests passed.
- Full: 492 files passed; 5597 tests passed, 4 skipped.
- Typecheck: passed.

# 310 — codex-harness-studio-ui — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- User-provided screenshots showed the exact mismatch: Claude form exposes transcript/harness controls, Codex form hides
  them. Code confirmed `showHarness = isAgent && hasClaude(form.cmd)`.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-01T12:58:22Z — pass (1/1) — source: tasks.md
- `npm test -- --run test/unit/agentStudio.test.ts && npm run typecheck` — pass

## Dogfood log

### 2026-07-01T12:58:28Z — pass (1/1) — source: tasks.md — commit: e6b6ac367fbd68dd3d340b1d2971375fb8466b2b
- `npm test -- --run test/unit/agentStudio.test.ts -t "codex"` — pass

### 2026-07-01T12:59:58Z — pass (1/1) — source: tasks.md
- `npm test -- --run test/unit/agentStudio.test.ts && npm run typecheck` — pass

### 2026-07-01T13:00:04Z — pass (1/1) — source: tasks.md — commit: e6b6ac367fbd68dd3d340b1d2971375fb8466b2b
- `npm test -- --run test/unit/agentStudio.test.ts -t "codex"` — pass

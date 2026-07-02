# 322 — probes-per-agent — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-02T02:02:44Z — pass (1/1) — source: tasks.md
- `env -u TMUX npx vitest run test/unit/probeView.test.ts test/unit/sidebarActions.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit` — pass

## Dogfood log

### 2026-07-02T02:02:50Z — pass (1/1) — source: tasks.md — commit: dc955cb411d369d3bffc5c57c6b9459b6acaffb0
- `env -u TMUX npx vitest run test/unit/probeView.test.ts -t "caller"` — pass

# 323 — activity-injected-context — notes

_Created 2026-07-02._

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

### 2026-07-02T13:34:45Z — pass (1/1) — source: tasks.md
- `env -u TMUX npx vitest run test/unit/claudeNormalizer.test.ts test/unit/codexNormalizer.test.ts test/unit/activityView.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit` — pass

## Dogfood log

### 2026-07-02T13:34:51Z — pass (1/1) — source: tasks.md — commit: 3a5f9d5f9de1e5b3b128f0cd28241d6f11b11525
- `env -u TMUX npx vitest run test/unit/claudeNormalizer.test.ts test/unit/codexNormalizer.test.ts -t "injected"` — pass

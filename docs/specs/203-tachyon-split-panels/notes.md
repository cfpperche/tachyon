# 203 — tachyon-split-panels — notes

_Created 2026-06-10._

## Design decisions

### 2026-06-10 — parent — capture stores the tree verbatim, agents pack in leaf order

Arbitrary hand-built arrangements don't reduce to presets, so the yml gains a
`layout:` tree (normalized to 2-decimal proportions for readability). Agents
captured per group pack into leaves sequentially on re-apply; file-only groups
keep a seat in the geometry but not a name — documented v1 stance.

## Deviations

## Tradeoffs

## Open questions

## Verification log

### 2026-06-10T22:17:16Z — pass (1/1) — source: tasks.md
- `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'` — pass

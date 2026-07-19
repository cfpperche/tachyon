# 413 — create-task-authoring-guidance — notes

_Created 2026-07-19._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Zod's field-local `errorMap` receives the rejected input, so it can calculate a code-point or entry count while native `.max(...)` retains `maxLength` and `maxItems` in the MCP JSON schema.
- Error construction interpolates only the field and numeric sizes. Rejected content is never echoed.

## Deviations

None.

## Tradeoffs

- The body error carries more guidance than other field errors but remains under the asserted 1,500-character response cap. This keeps the preservation/decomposition path at the exact failure point without inflating every validation message.

## Open questions

None.

## Final verification

- Focused MCP and TaskStore suite: 95 passed.
- Product Invariant gate: PI-001, 2 passed.
- `npm run typecheck`: passed.
- `npm run verify:full:quiet`: 437 files passed; 5,036 tests passed and 3 skipped.
- SDD ID uniqueness: passed.

## Verification log

### 2026-07-19T22:00:20Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/bridge.test.ts test/unit/taskStore.test.ts` — pass

## Dogfood log

### 2026-07-19T22:00:33Z — pass (1/1) — source: tasks.md — commit: bc5e9e531075212e6a008dc98448586b74aa2e59
- `npx vitest run test/unit/bridge.test.ts -t "create_task rejects oversized authoring input atomically with decomposition guidance"` — pass

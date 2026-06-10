# 204 — tachyon-multi-root — notes

_Created 2026-06-10._

## Design decisions

### 2026-06-10 — parent — plain-object tolerance in item handlers

The integration suite (and any external automation) invokes item commands with
plain `{ agentName }` objects. Handlers resolve `item.ws ?? the-single-workspace`
instead of requiring the tree item class — keeps the public command surface
backward-compatible and the phase-1 gate honest.

### 2026-06-10 — parent — folders without tachyon.yml

Only folders WITH a config get a Workspace; when none has one, the first folder
hosts Tachyon so "New Agent" can create the file. A yml created later in an
unregistered folder registers on window reload (documented non-goal for v1).

## Deviations

### 2026-06-10 — parent — phases 2-4 landed with phase 1

The provider rewrite (workspace-list source) was needed once either way;
doing it twice (single-ws then multi-ws) would have produced churn without
extra safety — the phase-1 gate (untouched single-root suite) still held.

## Tradeoffs

## Open questions

## Verification log

### 2026-06-10T23:34:18Z — pass (1/1) — source: tasks.md
- `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'` — pass

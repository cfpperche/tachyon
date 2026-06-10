# 201 — tachyon-runbook-crud-ui — notes

_Created 2026-06-10._

_In-flight design memory for this spec — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

**Entry shape:** `### YYYY-MM-DD — <author> — <one-line title>` followed by free-prose body.

## Design decisions

### 2026-06-10 — parent — runbook tab hides cmd AND cwd

A runbook has no cwd of its own — each step inherits the workspace root (command
refs use their declared cwd). Showing the field would imply per-runbook cwd
semantics the runner doesn't have.

### 2026-06-10 — parent — live resolution hint instead of a structured editor

The textarea + "lint → command · ./deploy.sh → inline shell" hint teaches the
resolution rule in place. The hint logic ships twice by design: `stepResolutions`
in formLogic (unit-tested truth) and a mirror in webview JS (rendering); both are
one line off `commandNames.includes`.

## Deviations

## Tradeoffs

## Open questions

## Verification log

### 2026-06-10T20:53:44Z — pass (1/1) — source: tasks.md
- `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'` — pass

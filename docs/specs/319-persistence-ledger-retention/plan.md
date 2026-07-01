# 319 — persistence-ledger-retention — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Apply retention at the writer edge, not through a new background maintenance loop. The only current writers for these
ledgers are Tachyon's materialized persistence hook scripts, so each successful append can immediately run a best-effort
prune pass.

The retention helper keeps at most 2000 valid JSONL rows. Within that hard row bound it first preserves the newest valid
row per diagnostic key: `agent + event + script`, then fills the remaining budget with the newest rows. For
`persistence-stop.jsonl`, `script` is absent, so the key naturally becomes `agent + Stop`. Malformed/partial lines are
ignored during pruning; they do not crash the hook and they are removed once retention runs.

If the selected rows still exceed 256 KiB, the helper drops oldest selected rows until the compacted file is at or below
the byte cap, keeping at least the newest row when a single row is larger than the cap. Compaction writes through a temp
file in the same directory and renames over the target, so a process crash does not leave a half-written ledger.

The helper is implemented twice by design:

- A TypeScript helper in `src/activity/sessionOwners.ts` for tests and future diagnostics/maintenance code.
- An embedded CommonJS snippet inside each materialized hook script, because those scripts must run standalone from the
  runtime process without importing Tachyon's bundle.

Retention applies to:

- `.tachyon/activity/persistence-stop.jsonl` after Stop recorder appends.
- `.tachyon/activity/persistence-hooks-failures.jsonl` after any hook failure row is appended.

## Key decisions

- Use row-count retention as the primary bound: at most 2000 valid rows per ledger after a writer append.
- Preserve latest per `agent/event/script` within that hard row budget so diagnostics favor the newest signal for each
  key before filling with the newest tail rows.
- Also enforce a 256 KiB byte cap when possible, which gives a disk guard without introducing age-based clock ambiguity.
- Use temp-file plus rename for compaction writes.
- Retention is best-effort. If pruning fails, the hook still exits cleanly.

## Files touched

- `src/activity/sessionOwners.ts`
- `test/unit/sessionOwners.test.ts`

## Risks & unknowns

- Highest risk: pruning the latest evidence per agent/event. Mitigation: preserve latest valid row per
  `agent/event/script` before tail rows, bounded by the hard row/byte caps.
- Secondary risk: retention code inside hooks blocks runtime exit. Mitigation: all pruning errors are swallowed.
- Long-term risk: many unique agent/event/script keys can add rows beyond the 2000-row recent window. This is acceptable
  for v1 because configured agents are bounded; spec 316 can surface unusual growth if needed.

## Sources consulted

- `docs/specs/312-silent-persistence-hooks/`
- `docs/specs/317-persistence-hook-failure-log/`
- `docs/specs/320-persistence-handoff-candidates/`
- `src/activity/sessionOwners.ts`
- `src/activity/logStore.ts`
- `test/unit/sessionOwners.test.ts`

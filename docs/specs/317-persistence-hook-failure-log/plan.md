# 317 — persistence-hook-failure-log — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a separate append-only JSONL failure ledger beside the existing persistence Stop ledger:
`.tachyon/activity/persistence-hooks-failures.jsonl`.

The materialized hook scripts remain self-contained CommonJS strings in `src/activity/sessionOwners.ts`. Each script gets
an optional failure-log path argument when silent persistence is active. On a catch path, it appends one sanitized row and
then still swallows the error so Claude/Codex are never blocked by Tachyon bookkeeping.

The initial implementation records failures from the scripts that Tachyon owns and materializes for persistence/ownership:
session owner recorder, handoff pointer, continuity pointer, and Stop recorder. This keeps the schema shared before spec
316 builds diagnostics on top of it.

## Key decisions

- Schema:
  - `agent`
  - `event`
  - `script`
  - `ts`
  - `reason`
  - `path`
- `reason` is bounded to a short message; no raw hook stdin, stack trace, env, or payload is logged.
- `SyntaxError` uses a fixed `syntax-error` reason instead of `Error.message`, because Node parse errors can include
  excerpts of malformed hook stdin.
- Logging failure is swallowed separately from the original hook failure.
- The file is append-only and deliberately unbounded in this spec; spec 319 owns retention.

## Files touched

- `src/activity/sessionOwners.ts`
- `src/harness/HarnessManager.ts`
- `test/unit/sessionOwners.test.ts`
- `test/unit/harness.test.ts`

## Risks & unknowns

- Highest risk: logging too much hook stdin or making hook failure visible to the runtime/user. Mitigation: log a fixed
  reason for parse failures, otherwise log only a bounded sanitized error/string reason, and never print to stdout/stderr.
- Secondary risk: command argument drift between Claude settings and Codex TOML. Mitigation: focused tests assert both
  generated hook forms include the failure log path.

## Sources consulted

- `docs/specs/312-silent-persistence-hooks/`
- `docs/specs/314-persistence-hooks-v2/`
- `src/activity/sessionOwners.ts`
- `src/harness/HarnessManager.ts`
- `test/unit/sessionOwners.test.ts`
- `test/unit/harness.test.ts`

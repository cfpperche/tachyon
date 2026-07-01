# 317 — persistence-hook-failure-log — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Failure rows use `.tachyon/activity/persistence-hooks-failures.jsonl`, colocated with the other machine-local
  activity ledgers.
- The materialized scripts log only minimal local diagnostics: `agent`, `event`, `script`, `path`, `reason`, `ts`.
- `SyntaxError` is logged as fixed `syntax-error` rather than the runtime message, because malformed JSON parse errors
  can include snippets of hook stdin.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- Claude review found that plain sanitized `Error.message` was not sufficient for parse failures; the implementation was
  tightened before ship.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Retention is still deferred to spec 319. The file is append-only in this spec so diagnostics can consume one stable
  ledger before retention policy is introduced.
- The failure logger is intentionally duplicated inside each materialized CommonJS script because those scripts must run
  without importing Tachyon internals from the target runtime process.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Spec 316 should consume the latest relevant row and classify hook failures in the UI/health surface.
- Spec 319 should cap or prune this ledger.

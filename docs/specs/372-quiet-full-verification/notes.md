# 372 — quiet-full-verification — notes

_Created 2026-07-11._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Baseline successful full runs observed in this orchestration emitted roughly 7–8k tool-output tokens each. The
  target is below 1 KiB/roughly 100–200 tokens on success, a greater than 95% transcript reduction without fewer tests.
- Local Vitest JSON contains `testResults[]` per file, top-level exact test counters, and assertion
  `failureMessages[]`; its `num*TestSuites` count nested suites and must not be labeled as files.
- Failure bounds: first 10 failing assertions, 2 KiB each, 24 KiB total; retain a private full log for everything
  omitted.

## Deviations

None yet.

## Tradeoffs

- Successful runs deliberately discard their full logs because their only durable evidence is exit status and exact
  counters. Failed runs retain logs because diagnosis may need context omitted by the transcript cap.

## Open questions

None.

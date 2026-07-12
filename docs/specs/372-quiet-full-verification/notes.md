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

- The coordinator audit found that file-level Vitest infrastructure errors were present in JSON but omitted when no
  assertion failed, and that failure-path unit tests leaked their intentionally retained logs. `89b3489` added bounded
  deduplicated file diagnostics and deterministic test cleanup without changing production failure retention.
- The initially planned final verbose rerun was not repeated after the two audit regression tests. Candidate dogfood
  had already proved exact quiet/verbose equivalence at 301 files and 3,556 tests; final closure used the now-default
  quiet gate at 301 files and 3,558 tests to avoid a redundant high-output full run.

## Tradeoffs

- Successful runs deliberately discard their full logs because their only durable evidence is exit status and exact
  counters. Failed runs retain logs because diagnosis may need context omitted by the transcript cap.

## Open questions

None.

## Dogfood log

- 2026-07-11, candidate `043c79e`: quiet exited 0 with 156 bytes/7 lines; quiet and verbose both reported 301 files,
  3,553 passed, 3 skipped, 3,556 total.
- 2026-07-11, final `89b3489`: `npm run verify:full:quiet` exited 0 with 301 files, 3,555 passed, 3 skipped,
  3,558 total; `npm run typecheck` and `git diff --check` passed.
- Temporary hygiene proof around the final full run: test fixture directories remained 28→28 and retained runner
  directories remained 21→21. Existing retained failure evidence was not destructively removed.
- 2026-07-11 post-closure regression `17205a1`: the config assertion now scopes uniqueness to the YAML `verify.full`
  entry instead of counting legitimate command mentions inside workspace-local agent instructions. Final rerun passed
  301 files, 3,559 tests, and 3 skipped; typecheck and diff-check passed.

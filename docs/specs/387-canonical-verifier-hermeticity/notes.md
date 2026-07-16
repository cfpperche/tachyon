# 387 — canonical verifier hermeticity — notes

## Decisions

- Keep checkout, temp and cache material inside each phase's existing owned transaction directory. The
  failed shortening attempt still produced a 106-byte socket path for a 100-byte guard and also made
  concurrent verifier tests share cleanup state, so it was reverted. Only test socket fixtures use a
  short Linux temp root.
- Store capped tails rather than first lines because Vitest summaries and assertion failures are emitted
  near the end. Keep stderr and stdout separately in records and label both in blocker details.
- The existing reproducible install flags remain intact; `npm run build` explicitly creates the ignored
  artifacts needed by tracked tests.

## Scope correction

- An initial verifier path-shortening implementation was rejected after the real path calculation and
  long-`TMPDIR` reproduction showed it did not solve the socket failure. The final approach is limited to
  the project-owned socket fixtures that append socket paths.

## Verification

- Long-`TMPDIR` focused suites: 7 files, 145 tests passed.
- Exact affected command under the original long path shape: 119 files, 1,504 tests passed.
- Typecheck, PI-001 (2 tests) and full verification (4,672 passed, 3 skipped) passed.
- A fresh tracked-only clone at candidate `0cc40bd9` ran `verify:prepare`, materialized
  `dist/engine/engine-daemon.cjs`, remained Git-clean and passed the same 119 files / 1,504 tests.

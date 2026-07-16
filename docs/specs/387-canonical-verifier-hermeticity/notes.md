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

## Canonical dogfood

- Delivery `d-spawn-e36b29e75c4e12d09a30eab2fbef6c28` was verified from BASE
  `9a67afad` to disposable HEAD `e228a9a1` with no waiver.
- `verify_task` returned `accept`: preparation passed in every clean clone, the direct behavior oracle
  was RED at BASE and GREEN at HEAD, typecheck passed, and affected tests passed.
- Evidence: `.tachyon/verifications/e228a9a17bcc8d3e865ed920296166280537bc7f.2d9ef1df0983f8f9.json`.
- The disposable comment, branch and worktree were removed; no probe code was integrated.

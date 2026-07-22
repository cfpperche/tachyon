# 431 — agent-profile-identity-lifecycle — notes

_Created 2026-07-22._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Profile forget intentionally does not call the broad legacy `forgetAgent()` cleanup because that path owns harness and Pi runtime-home deletion, which is outside this slice's authority.
- Live forget is refused; live rename is allowed only through canonical commit followed by retryable runtime convergence.
- Probe `probe-58b1346f-3728-4069-9c4d-6a5adf909f96` showed that persistent rename, live convergence and forget do not share one safe irreversible boundary. They were decomposed into `t-152041`, `t-c3605c` and `t-980e6e` before production code.

## Deviations

- Canonical forget quarantines the complete profile home instead of deleting selected children. This keeps current Evolution and future profile-local plugin bytes recoverable while still removing the active locator.

## Tradeoffs

- Completed retirement receipts remain durable and teach legacy GC which name-only runtime state must be retained. This costs a small permanent receipt but prevents delayed cleanup from violating retirement custody.

## Open questions

None. All three child SDDs shipped and their phase/recovery contracts are recorded in SDDs 432, 433 and 436.

## Closure evidence

- Persistent canonical rename: `599441cc` / SDD 432.
- Live convergence: `885f8e9d` / SDD 433.
- Canonical forget: `c8bcf33c` / SDD 436.
- Final main gate after the third slice: 475 files passed; 5,434 tests passed; 3 skipped; typecheck passed.

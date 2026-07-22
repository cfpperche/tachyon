# 431 — agent-profile-identity-lifecycle — notes

_Created 2026-07-22._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Profile forget intentionally does not call the broad legacy `forgetAgent()` cleanup because that path owns harness and Pi runtime-home deletion, which is outside this slice's authority.
- Live forget is refused; live rename is allowed only through canonical commit followed by retryable runtime convergence.
- Probe `probe-58b1346f-3728-4069-9c4d-6a5adf909f96` showed that persistent rename, live convergence and forget do not share one safe irreversible boundary. They were decomposed into `t-152041`, `t-c3605c` and `t-980e6e` before production code.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

Each child SDD must resolve its own exact phase/recovery table and cross-lock ordering before code.

# 438 — agent-profile-studio — notes

_Created 2026-07-22._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-22 — Architecture probe `probe-ba265098-ea19-4b80-9f94-8b08fb7ea578` correctly identified that the original task crossed four independently reviewable boundaries. The umbrella was decomposed into `t-fdb422`, `t-293326`, `t-ecd405` and `t-fa332a`.
- 2026-07-22 — Probe suggestions for a generic import-plan registry, conflict-choice framework and new secret-binding API were not adopted. Existing bundle import is already validate-before-commit and V1 does not edit secrets; adding those abstractions would not close current acceptance.
- 2026-07-22 — Canonical and legacy modes remain a discriminated boundary. Canonical persistence never receives the legacy `FormState` wholesale.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

None.

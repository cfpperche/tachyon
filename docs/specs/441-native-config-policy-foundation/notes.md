# 441 — native-config-policy-foundation — notes

_Created 2026-07-23._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- The support catalog remains empty. Profiles without `nativeConfig` are unchanged; profiles that author it receive a stable unsupported-policy diagnostic until an adapter slice declares measured support.
- Studio provenance contains only policy vocabulary and support status. It never includes native file bytes, credentials or runtime-mutated state.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- Installed visual inspection was deferred to the first adapter slice: no combination is supported yet, so production profiles cannot exercise a populated row, and the user explicitly excluded the beta desktop harness.

## Adversarial hardening

- Claude Fable correctly identified that a literal-only `unsupported` result was a stub rather than an adapter extension seam. Task `t-e05e00` widened the closed decision, kept deny-by-default production behavior and proved exact-tuple/mixed-support admission with a synthetic resolver.
- Authentication and memory remain schema families because parity must measure them. Their bytes/state remain outside authored policy.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

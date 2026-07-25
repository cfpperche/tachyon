# 457 — pi-canonical-parity — notes

_Created 2026-07-25._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Pi 0.80.10 offline print mode exits successfully but emits only a session envelope. It is not a semantic capability probe, so Pi remains deliberately unsupported by `probe_agent`.

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

- The one-live-Pi OAuth admission remains necessary until upstream provides a shared credential-store or auth-file hook; separate private paths cannot safely reconcile concurrent refreshes.

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

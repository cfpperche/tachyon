# 447 — runtime-config-devhost-fixture — notes

_Created 2026-07-24._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Multi-slot pointing copies a fixture `.runtime-config-global-home` into the owner slot's profile
  home on every point, so Global inventory is controlled and isolated.
- The workspace mirror copies `.codex` as a real directory, preventing dogfood saves from mutating
  the tracked fixture. The fixture includes scalar settings, MCPs, runtime-managed hook state, a
  preserved SessionStart hook and a preserved skill entry.
- Pointer regression coverage confirms `.codex` is copied into the disposable mirror and the focused
  runtime/cockpit suite is green.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

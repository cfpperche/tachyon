# 396 — engine-stable-dev-channels — notes

_Created 2026-07-17._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-17 — Stable packaging is tied to the exact cached `origin/main`, without an automatic fetch.  Fetching is an explicit operator action; build/test commands remain deterministic and cannot mutate remote refs.
- 2026-07-17 — New manifests and identities always carry a channel, but parsers accept omission for the installed 0.56.17 migration and verified rollback only.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

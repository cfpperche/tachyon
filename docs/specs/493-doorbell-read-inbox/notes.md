# 493 — doorbell-read-inbox — notes

_Created 2026-08-06._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- **No default 24h time window on `read_notices`; no "most recent N" default either.** `plan.md`'s Risks
  section proposed defaulting `since` to 24h-before-now. Implemented instead: omitting `since` starts
  from the OLDEST matching notice and returns up to `READ_NOTICES_MAX` (200), with `truncated` set when
  more exist — i.e. the default is "from the beginning," not "most recent." This is the correct shape for
  a forward-only cursor (`since` is the only paging parameter, there is no "before"): a coordinator
  paging with `since: <last at returned>` on each subsequent call is guaranteed to eventually see every
  notice in order and never skip one, which "return the most recent N" would not guarantee for a caller
  that fell more than one page behind. A 24h-relative default was rejected for the same class of reason
  it was originally proposed for — it silently drops anything older than 24h even on someone's FIRST
  call, which is exactly wrong for `t-167b5c`'s "ficou ocupado por horas" (could be well over 24h across
  a weekend).
- **`readDoorbellEventsFor` sorts by `at` explicitly** rather than trusting file order. A test
  (`readDoorbellEventsFor returns only events addressed to the given agent, oldest-first`) appended
  events out of chronological order on purpose and caught that file-append order and `at`-chronological
  order are not guaranteed to be the same thing (e.g. clock skew across concurrent writers is at least
  conceivable, even if unobserved today). Sorting is O(n log n) on an already-bounded-then-filtered list,
  cheap enough not to matter at this scale.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

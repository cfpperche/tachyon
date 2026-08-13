# 503 — notify-agent-stranded-composer — notes

_Created 2026-08-13._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- The retained queue item is the external ownership mark. Prefix/suffix alone are diagnostic, not authority.
- Root cause: `flushQueuedNotice` retains an unconfirmed submit, but the sole idle-edge recovery is exhausted; later recovery returns at `humanDraftPresent` because occupancy cannot distinguish the retained queue head from human text.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

- Exact equality is deliberately narrower than provenance recognition. It cannot rescue a mutated or partially edited Tachyon line, but it cannot mistake unrelated human text for queue-owned content.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

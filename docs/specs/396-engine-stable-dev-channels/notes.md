# 396 — engine-stable-dev-channels — notes

_Created 2026-07-17._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-07-17 — Stable packaging is tied to the exact cached `origin/main`, without an automatic fetch.  Fetching is an explicit operator action; build/test commands remain deterministic and cannot mutate remote refs.
- 2026-07-17 — New manifests and identities always carry a channel, but parsers accept omission for the installed 0.56.17 migration and verified rollback only.
- 2026-07-17 — Dev Host stages the engine with a fixture-local link to the standalone Node runtime.  Reusing the VS Code Electron executable outside its installation directory failed because its shared libraries were unavailable to the detached systemd unit.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- The existing Dev Host cleanup helper also stops the exact persistent engine unit derived from the canonical fixture workspace before removing files.  The old helper only knew the persistent Bridge, which let the engine auto-restart against a deleted fixture.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Dogfood log

- 2026-07-17 — `npm run dogfood:dev-host -- headless` passed all eight real Extension Development Host checks with a `dev` manifest and fixture-private cache/state/data.  `npm run dogfood:dev-host -- clean` then stopped the exact fixture engine, tolerated a proven-stale fixture tmux socket, removed the fixture, and left its systemd unit inactive/collected.  The installed stable engine was not addressed.

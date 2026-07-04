# 355 — adhoc-transcript-isolation — notes

_Created 2026-07-04._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Ad-hoc AI agents now reuse the existing `isolate: "transcript"` path by default instead of introducing a separate ad-hoc-only transcript mechanism. That keeps Codex and Claude behavior aligned with the persisted-agent transcript isolation feature and avoids a second ownership model.
- Activity's shared-folder warning now keys off actual transcript namespace ambiguity (`cwd + configHome` shared and no live transcript attribution) instead of only shared `cwd`. This avoids false positives for ad-hoc agents that intentionally share the worktree but have private transcript homes.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Human dogfood still needs a VSIX install/reload to confirm that ad-hoc Codex and Claude Activity panels no longer show `history unavailable` while keeping continuity/handoff pills absent.

## Validation log

- 2026-07-04: `npm test -- test/unit/agentManager.test.ts test/unit/activityView.test.ts` passed: 174 tests.
- 2026-07-04: `npm run typecheck` was blocked by unrelated dirty work in `src/config/loadConfig.ts`: `Property 'declaredOwner' is missing in type ... but required in type 'TachyonConfig'`.
- 2026-07-04: Re-ran `npm test -- test/unit/agentManager.test.ts test/unit/activityView.test.ts`; passed: 176 tests.
- 2026-07-04: Re-ran `npm run typecheck`; now blocked by unrelated in-flight plugin UI work in `src/plugins/ui/host.ts` (`READY` unused, invalid `retainContextWhenHidden` option, `Thenable`/Promise mismatch, async `manager.list()` misuse). These files were not changed for spec 355.

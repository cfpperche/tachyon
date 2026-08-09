# 501 — tasks

_Created 2026-08-09._

**Verify:** `npm run verify:full:quiet`

Ordered. This spec is small on purpose — most of it already exists.

## S1 — read what exists, before writing anything

- [x] Read `src/worktree/review.ts` (80 lines), `reviewWorktreeDiff` in `extension.ts` (~:623-646), the
      `createWorktreePrItem` registration (`extension.ts:3565`), `SidebarPrototype.ts:84-85` and
      `sidebar/actions.ts:25`.
- [x] Record in `notes.md`: how the sidebar action reaches the command today. The new actions follow
      that path — **do not invent a second routing pattern.**
- [x] Answer plan.md § D2 by measurement: what it costs to serve the current side from `head` instead
      of the working tree, given the content provider already takes `cwd` + `ref`. Record the answer
      and the choice.

## S2 — review from the land door

- [x] Red first: a test that the worktree row exposes a review action when the land block renders.
- [x] The action dispatches to the existing command. A guard test fails if a second diff-picking or
      diff-opening implementation appears anywhere.
- [x] Empty case: a branch with no changes says so, and does not open a picker.
- [x] The base being compared is named on screen (plan.md § D2), whichever comparison was chosen.
- [x] `landCommandNeverExecuted.test.ts` green, unmodified.

## S3 — propose from the land door

- [x] Red first: a test that the row exposes a propose action, and that it dispatches to
      `tachyon.createWorktreePrItem` rather than to any new flow.
- [x] No `gh` process is spawned on render — readiness is probed at click, as spec 223 built it. Write
      the test that fails if a refresh spawns one.
- [x] No remote or no `gh`: the existing refusal reaches the human by name. Land is unaffected.

## Visual QA — REQUIRED, and the maintainer inspects before this lands

The maintainer asked to see this in a dev host before it is merged. Do not treat the screenshots as the
end of the job.

- [x] Does the land block still read as one decision, or does it now read as three competing buttons?
- [x] Is Propose distinguishable from Land at a glance, on a repository that never opens a PR?
      (spec.md § Open question 2 — this is the decision Visual QA owns.)
- [x] A blocked land: are review and propose still sensible when the checks are red?
- [x] Evidence: screenshots of a ready land block and a blocked one, at 880 and 360
      (`.tachyon/visual-qa/t-3eaf77-land-door/`). **The picker is NOT screenshotted** — it is VS Code's
      own chrome and the headless harness cannot render it; notes.md § Visual QA says so rather than
      describing a screen nobody measured. The maintainer sees it in the dev host.
- [x] Verdict: recorded after looking, including anything changed as a result.

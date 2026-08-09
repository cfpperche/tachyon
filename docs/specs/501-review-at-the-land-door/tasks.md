# 501 — tasks

_Created 2026-08-09._

**Verify:** `npm run verify:full:quiet`

Ordered. This spec is small on purpose — most of it already exists.

## S1 — read what exists, before writing anything

- [ ] Read `src/worktree/review.ts` (80 lines), `reviewWorktreeDiff` in `extension.ts` (~:623-646), the
      `createWorktreePrItem` registration (`extension.ts:3565`), `SidebarPrototype.ts:84-85` and
      `sidebar/actions.ts:25`.
- [ ] Record in `notes.md`: how the sidebar action reaches the command today. The new actions follow
      that path — **do not invent a second routing pattern.**
- [ ] Answer plan.md § D2 by measurement: what it costs to serve the current side from `head` instead
      of the working tree, given the content provider already takes `cwd` + `ref`. Record the answer
      and the choice.

## S2 — review from the land door

- [ ] Red first: a test that the worktree row exposes a review action when the land block renders.
- [ ] The action dispatches to the existing command. A guard test fails if a second diff-picking or
      diff-opening implementation appears anywhere.
- [ ] Empty case: a branch with no changes says so, and does not open a picker.
- [ ] The base being compared is named on screen (plan.md § D2), whichever comparison was chosen.
- [ ] `landCommandNeverExecuted.test.ts` green, unmodified.

## S3 — propose from the land door

- [ ] Red first: a test that the row exposes a propose action, and that it dispatches to
      `tachyon.createWorktreePrItem` rather than to any new flow.
- [ ] No `gh` process is spawned on render — readiness is probed at click, as spec 223 built it. Write
      the test that fails if a refresh spawns one.
- [ ] No remote or no `gh`: the existing refusal reaches the human by name. Land is unaffected.

## Visual QA — REQUIRED, and the maintainer inspects before this lands

The maintainer asked to see this in a dev host before it is merged. Do not treat the screenshots as the
end of the job.

- [ ] Does the land block still read as one decision, or does it now read as three competing buttons?
- [ ] Is Propose distinguishable from Land at a glance, on a repository that never opens a PR?
      (spec.md § Open question 2 — this is the decision Visual QA owns.)
- [ ] A blocked land: are review and propose still sensible when the checks are red?
- [ ] Evidence: screenshots of a ready land block, a blocked one, and the picker VS Code opens.
- [ ] Verdict: recorded after looking, including anything changed as a result.

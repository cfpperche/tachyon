# 500 — tasks

_Created 2026-08-09._

**Verify:** `npm run verify:full:quiet`

Ordered. S1 and S2 leave the product working with both old screens still reachable; S3 is the one that
deletes.

## S1 — the id resolves before anything moves

- [ ] Read `sectionNav.ts:20-105` first, including the `fleet` and `mission` comments. They are the
      precedent this slice applies, and the guard at `:101-105` throws if you get it wrong.
- [ ] Red first: a test asserting `overview` and `engine` both resolve to `system`.
- [ ] Add `system` as a `CockpitSectionId`; keep `overview` and `engine` decodable, resolving to it.
- [ ] The eight default fallbacks in `route.ts` stay **untouched** — prove it by diffing that file and
      showing only the resolution change. If a fallback needs editing, stop and re-read plan.md § D1.

## S2 — System exists and shows everything both screens showed

- [ ] Red first: a test that System renders every counter Overview had and every field Engine's cards
      had, from one model.
- [ ] `src/webview/system/` + `SystemPanel.ts`, registered as `tachyonSystem` in `surfaces.ts`.
- [ ] Summary derived from the same `control.workspaces` the cards render (plan.md § D3), **not** from
      `control.summary`. Test: a model where the two would disagree renders one consistent answer.
- [ ] `inboxPending` and `worktreesActive` keep their current sources and the Inbox counter still
      navigates.
- [ ] All four actions present: auto-refresh, refresh, copy diagnostics, open doctor.
- [ ] Collapse rule from plan.md § D4: one workspace expanded; more than one collapsed; an engine in
      `error` expanded regardless.
- [ ] Do not delete `model.overview` yet — `model.ts:563-565` reads it for diagnostics. Measure its
      consumers and report them.

## S3 — the pair is deleted, with no tombstone

- [ ] One System tile replaces the Overview and Engine tiles in the launcher.
- [ ] Delete `src/webview/overview/`, `OverviewPanel.ts`, `src/webview/engine/`, `EnginePanel.ts`, and
      their `surfaces.ts` rows.
- [ ] Registration, command routing, preview catalog and fixtures, CSS and localization go **in this
      commit**. The Mission Control rename needed a second tombstone commit; the Execution removal
      (`t-af240d`) did not. Match the second one.
- [ ] Residue grep for `tachyonOverview`, `tachyonEngine`, `OverviewPanel`, `EnginePanel`,
      `overviewTitle`, `engineTitle`. Report what survives and why — some words are legitimate.
- [ ] `node esbuild.mjs` green.

## Visual QA

Required — spec.md says so, and Open question 3 is the reason.

- [ ] One workspace: does the page read as one screen, or as two stapled together?
- [ ] Two or more workspaces: is the second visible without scrolling past a wall?
- [ ] A workspace with its engine in `error`: is it obvious which one, from the top of the page?
- [ ] Evidence: screenshots of all three, plus the old Overview and Engine for comparison.
- [ ] Verdict: recorded after looking, including anything fixed as a result. If the collapse default is
      wrong, fix the layout — do not revert the merge.

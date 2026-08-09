# 500 — tasks

_Created 2026-08-09. Delivered 2026-08-09 (t-7b92bd)._

**Verify:** `npm run verify:full:quiet`

Ordered. S1 and S2 leave the product working with both old screens still reachable; S3 is the one that
deletes.

## S1 — the id resolves before anything moves

- [x] Read `sectionNav.ts:20-105` first, including the `fleet` and `mission` comments. They are the
      precedent this slice applies, and the guard at `:101-105` throws if you get it wrong.
      — read, and worth recording: the guard is **vacuous today**. It iterates `COCKPIT_SECTION_ORDER`,
      which SDD 485 Phase D emptied, so it protects nothing at present. It is satisfied by construction
      here (two tiles became one, and no id was added to that list) rather than by anything this slice
      did.
- [x] Red first: a test asserting `overview` and `engine` both resolve to `system`.
      — `test/unit/systemSectionApp.test.ts`, red 6/7 before the change.
- [x] Add `system` as a `CockpitSectionId`; keep `overview` and `engine` decodable, resolving to it.
      — `resolveSectionDestination` in `route.ts`, additive; both ids stay in `COCKPIT_SECTION_IDS`.
- [x] The eight default fallbacks in `route.ts` stay **untouched** — prove it by diffing that file and
      showing only the resolution change. If a fallback needs editing, stop and re-read plan.md § D1.
      — proven two ways: the diff of `route.ts` is one added block and nothing else, and a test pins
      the three `section: "overview"` literals plus the three comment fallbacks in place.

## S2 — System exists and shows everything both screens showed

- [x] Red first: a test that System renders every counter Overview had and every field Engine's cards
      had, from one model.
- [x] `src/webview/system/` + `SystemPanel.ts`, registered as `tachyonSystem` in `surfaces.ts`.
- [x] Summary derived from the same `control.workspaces` the cards render (plan.md § D3), **not** from
      `control.summary`. Test: a model where the two would disagree renders one consistent answer.
      — and the guard is a RENDER, not a source scan. The first version checked that `App.tsx` contains
      no literal `control.summary`; injecting the real regression (reading `overview.enginesAttached`,
      which `model.ts:529` sets *from* `control.summary`) left it green. Replaced and re-proven red.
- [x] `inboxPending` and `worktreesActive` keep their current sources and the Inbox counter still
      navigates.
- [x] All four actions present: auto-refresh, refresh, copy diagnostics, open doctor.
- [x] ~~Collapse rule from plan.md § D4~~ — **CANCELLED by owner ruling** (t-7b92bd journal,
      2026-08-09). `control.workspaces` is 0 or 1 in production, so the rule's own trigger is
      unreachable; shipping it would be machinery with no tap. See notes.md § Deviations.
- [x] Do not delete `model.overview` yet — `model.ts:563-565` reads it for diagnostics. Measure its
      consumers and report them. — measured, table in notes.md; the field stays whole.

## S3 — the pair is deleted, with no tombstone

- [x] One System tile replaces the Overview and Engine tiles in the launcher.
- [x] Delete `src/webview/overview/`, `OverviewPanel.ts`, `src/webview/engine/`, `EnginePanel.ts`, and
      their `surfaces.ts` rows.
- [x] Registration, command routing, preview catalog and fixtures, CSS and localization go **in this
      commit**. The Mission Control rename needed a second tombstone commit; the Execution removal
      (`t-af240d`) did not. Match the second one.
      — plus the sidebar's engine-error dot (it addressed the Engine tile), the `tachyon.inspectEngine`
      command title, the pt-BR bundle, both dispose-only serializer rows, and the four tests that named
      the pair.
- [x] Residue grep for `tachyonOverview`, `tachyonEngine`, `OverviewPanel`, `EnginePanel`,
      `overviewTitle`, `engineTitle`. Report what survives and why — some words are legitimate.
      — every surviving hit is one of: a tombstone-explaining comment, a guard asserting absence, or a
      historical spec/evidence document. Reported in full in the commit body.
- [x] `node esbuild.mjs` green.

## Visual QA

Required — spec.md says so, and Open question 3 is the reason.

- [x] One workspace: does the page read as one screen, or as two stapled together? — one screen.
- [x] ~~Two or more workspaces: is the second visible without scrolling past a wall?~~ — **not
      photographed, because it does not exist.** Same measurement that cancelled D4; the owner's ruling
      explicitly dropped this shot rather than fabricating it from a fixture.
- [x] A workspace with its engine in `error`: is it obvious which one, from the top of the page? — yes.
- [x] Evidence: screenshots of all three, plus the old Overview and Engine for comparison.
      — `.tachyon/visual-qa/sdd-500/`, at 880 and 360, attached to t-7b92bd. Three after-cases
      (healthy, engine-error, two-roots-one-card), two before-cases, and the two shared-sheet
      neighbours before and after.
- [x] Verdict: recorded after looking, including anything fixed as a result. If the collapse default is
      wrong, fix the layout — do not revert the merge.
      — one defect found and fixed: the engine failure text broke mid-word at 880. notes.md § Visual QA.

# 500 — plan

_Created 2026-08-09. Ratified by the maintainer._

## Approach

One app, `system`, rendering the summary Overview computed and the per-workspace detail Engine
rendered — from the same rows, so the two cannot disagree. The old section ids keep decoding and
resolve to it.

## Decisions

### D1 — `system` is a new section id; `overview` and `engine` keep decoding and resolve to it

**The precedent is `fleet`, and it is documented in the code we are editing.** `sectionNav.ts:50-54`
records that `fleet` left the launcher grid by owner decision while staying a valid `CockpitSectionId`,
because it is still the parent of subroutes and "must still decode". `mission` is the same shape from
the other side: the label became Board and the id stayed `mission`.

So this product already separates *what the human can open* from *what must decode*. That is exactly
the tool this spec needs.

**This dissolves Open question 1.** `"overview"` is the default fallback in eight places in
`route.ts` (`:270`, `:277`, `:290`, `:322`, `:534`, `:602`, and the argument at `:301-303` for why the
default lives at the call site). None of them has to change: `overview` still decodes. It simply lands
on System.

**Rejected: renaming `overview` to `system` across the codebase.** It would touch every fallback and
every persisted route, to gain nothing a resolving alias does not already give.

### D2 — `tachyonOverview` and `tachyonEngine` are both retired; the surface is `tachyonSystem`

Both are declared standalone in `surfaces.ts:229` and `:233`. Reusing either id leaves a name in the
manifest that lies about what it opens; a human with the old tab open would keep a tab whose title and
icon no longer match its content.

A new `viewId` orphans both old tabs, which is the honest outcome: **the surface they showed no longer
exists.** Record in `notes.md` what a user with an old tab open sees, having actually opened one and
looked — do not predict it.

### D3 — the summary is computed from the rows on screen, not from `control.summary`

This is the acceptance criterion the measurement bought, and it is the only structural change of
substance.

Today `model.ts:529` sets `enginesAttached: control.summary.attachedEngines`, so the counter and the
cards are two reads of one object — consistent by construction today, but nothing holds them together
if either moves. In System they are on one screen, and a visible contradiction is a visible bug.

Derive the engine/agent/workspace counters **from the same `control.workspaces` array the cards
render**. `inboxPending` (`model.ts:470`) and `worktreesActive` (`model.ts:466`) are workspace-wide and
stay as they are — they have no per-row source, which is precisely why they are not derivable this way.

**Do not delete `model.overview`.** Measure its other consumers first — `model.ts:563-565` builds
diagnostics text from it.

### D4 — detail collapsed by default when there is more than one workspace

Open question 3 is the one that can make System worse than the pair. Engine's card is three
sub-cards plus `EngineLogPanel`; with a summary above it, the second workspace may be below the fold.

Rule: one workspace → expanded, nothing to scan past. More than one → collapsed to a header row
carrying name, hash and state badge, expandable. A workspace whose engine is in `error` starts
expanded regardless — the failing one is what you came for.

This is a starting position for Visual QA to overturn, not a conclusion.

### D5 — the actions survive, and any that do not are a recorded decision

Overview carries auto-refresh, refresh, copy diagnostics; Engine carries open doctor. Four actions on
one page is fine. If one is dropped, `notes.md` says which and why — spec.md § Acceptance forbids
losing one by omission.

## Files touched

- new: `src/webview/system/` (App.tsx, main.tsx, messages.ts, system.css), `src/webview/SystemPanel.ts`
- delete: `src/webview/overview/`, `src/webview/OverviewPanel.ts`, `src/webview/engine/`,
  `src/webview/EnginePanel.ts`
- `src/webview/surfaces.ts` — one row replaces two
- `src/cockpit/sectionNav.ts` — one tile replaces two; `overview`/`engine` stay decodable ids
- `src/cockpit/route.ts` — resolve both to `system`; the eight fallbacks stay untouched
- `src/cockpit/model.ts` — D3
- `src/webview/webviewApps.ts`, `src/extension.ts` — registration
- `scripts/webview-preview/` — routes and fixtures
- l10n bundles; `controlStrings.ts`
- tests: `controlSectionNav`, `webviewConvention`, `cockpit`, plus new System tests

## Risks

- **A tile that decodes but has no destination.** `sectionNav.ts:101-105` throws when Control renders a
  section the launcher has no tile for. Removing two tiles while keeping two ids must satisfy that
  guard, not disable it. Read it before editing.
- **The removal half is where lápides come from.** The Execution removal (`t-af240d`) got this right
  and the Mission Control rename did not. Registry, route, manifest, preview catalog, CSS and
  localization go with the code.
- **Density.** Named in D4. If Visual QA says the collapsed default is wrong, the fix is layout, not
  reverting the merge.

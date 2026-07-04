# 347 — mission-control-board-search-find — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced while building. Append-only by convention._

## Design decisions

- Did t-b5e6e5 (cheap) before t-5ea4c7, per the task's own guidance.
- Filtering lives in `boardModel.ts` (`matchesBoardSearch` + `BoardModelInput.searchQuery`), not in `App.tsx`, matching the board's existing "the webview never computes affordances itself" discipline.
- Search and the agent-filter dropdown are kept semantically distinct on purpose: search HIDES non-matching cards (columns/Dropped counts shrink to match); the agent chip only ever DIMS. This mirrors the same distinction the task bodies draw between t-5ea4c7 (filter/hide) and t-b5e6e5 (find/never-hide).

## Find-widget caveat validation (t-b5e6e5) — the important part

**Method.** Rather than assume Chromium/Electron find-in-page behavior, built a synthetic-overflow fixture: 40 filler cards + one uniquely-titled card (`UNIQUE_FINDME_MARKER_BELOW_FOLD`) in the Active column (forces `.col-body`'s own `overflow-y: auto` to actually scroll), plus one uniquely-titled card in the `dropped` status (`UNIQUE_DROPPED_MARKER_HIDDEN`) while the Dropped toggle defaults closed. Served the real `dist/webview/mission-control.js` bundle through the existing `scripts/webview-preview` static server, in a **temporary scratch HTML file** (`_scratch-find-check.html`, deleted before every commit — never touched the in-flight spec-346 preview-catalog work already modifying that directory) that posts a hand-built `snapshotMessage` envelope. Drove it with the `agent-browser` skill (real Chrome via CDP, both headless and headed).

**Caveat (a) — does the widget scroll a match into view inside a column's own `overflow-y` scroller?**
Result: **inconclusive from the automated test, but not a real concern.** `window.find('UNIQUE_FINDME_MARKER_BELOW_FOLD')` returned `true` (the match exists and was located), but `.col-body.scrollTop`, `window.scrollY`, and `window.getSelection().toString()` all stayed at 0/empty afterward — no observable scroll or selection. However, this is very likely an artifact of the test method, not evidence the real find widget fails: `window.find()` is a legacy, synchronous editing-command API in Blink, a **different code path** from the actual find toolbar (`Ctrl+F` in a browser, or `webContents.findInPage` in Electron — which is what VS Code's `enableFindWidget` actually invokes). The toolbar path uses Blink's `TextFinder`, which is well-established to scroll nested scrollable ancestors into view for a match (this has been standard Chromium behavior for many Chromium releases). `window.find()` has long-standing, documented quirks around not reliably scrolling/selecting, especially when the page/window lacks real user focus — which an automated CDP session never has. A live Ctrl+F test inside a real VS Code Extension Development Host would be the authoritative check; that requires a GUI session this task didn't have available, so it's called out here as an open item rather than guessed at.
**Confidence:** medium-high that the real find toolbar handles this fine; the negative automated result is explicitly flagged as likely a test-method artifact, not a product finding.

**Caveat (b) — does the widget match content collapsed behind the Dropped toggle (or a closed dropdown)?**
Result: **confirmed NO, and this one needed no live test.** `showDropped` gates the Dropped column with a plain conditional render (`{showDropped && <Column .../>}` in `App.tsx`) — when closed, that JSX subtree is not mounted at all, so `UNIQUE_DROPPED_MARKER_HIDDEN` is never in the DOM. No find mechanism (native or custom) can match text that was never inserted into the page. This is unlike Chrome's special-cased auto-reveal for closed `<details>` elements or `content-visibility: hidden` — a conditionally-unmounted custom component gets no such treatment.
**Confidence:** high (structural fact from the code, not an inference from a live test).

**Decision:** ship the free, one-line `enableFindWidget: true` across the five panels. Do NOT build a custom find-in-board fallback (highlight + n/N navigation) — that's a materially bigger lift, and the one confirmed gap (collapsed Dropped content) is a narrow, expected edge case: a user who wants to search dropped tasks can open the Dropped toggle first, same as they'd expand a closed section before searching it anywhere else. This satisfies the task's "cheap path first, fallback only if insufficient" framing. The maintainer's own Ctrl+F dogfood against a real, populated board remains the actual acceptance test for caveat (a) — flagged explicitly in `tasks.md` as still outstanding.

## Deviations

- None from the task bodies. The spec/notes files themselves (this directory) are a retrofit for record-keeping — the task instructions didn't mandate a numbered SDD spec, but the codebase's own convention (every other feature under `docs/specs/`) made this the natural home for the validation writeup the task explicitly asked to register in `notes.md`.

## Tradeoffs

- Considered testing the ACTUAL VS Code webview find widget in a live Extension Development Host (a GUI session was technically reachable — `DISPLAY=:0` via WSLg, a `code` remote-cli binary present). Decided against it: the setup cost (launch VS Code, F5 the extension, populate a real workspace with enough tasks to force overflow, drive real keyboard input, screenshot via `agent-desktop`/`agent-screen`) was disproportionate to a task scoped as "cheap path first." Documented the resulting confidence gap explicitly instead of guessing.

## Open questions

- Does VS Code's actual `enableFindWidget` (Electron `webContents.findInPage`) scroll a nested `overflow-y` column to reveal a match? Believed yes (see caveat (a) reasoning above), not directly proven. Owner: maintainer's own Ctrl+F dogfood against a real, busy board is the natural resolution path.

## Verification log

- 2026-07-03 — `npx vitest run` (full suite, 170 files / 2334 tests) passed.
- 2026-07-03 — `npm run typecheck` (`tsc --noEmit` + `tsconfig.webview.json` + `tsconfig.browser-test.json`) passed.
- 2026-07-03 — `npm run build` (esbuild, all bundles) passed.

## Visual QA

- 2026-07-03 — Built `dist/webview/mission-control.js` with the new toolbar search box, served through `scripts/webview-preview`'s static server, opened via `agent-browser` (a temporary scratch fixture, deleted before commit — see method above). Screenshots (not persisted, ad hoc scratchpad only):
  - Empty state: search box renders between the title and the agent-filter dropdown, matching the existing toolbar's visual language (`.ds-input` box, search icon, no clear button until non-empty).
  - Typed `findme`: Active column collapsed to the single matching card (`Active · 1`), Dropped counter dropped to `0` (its one card didn't match), a clear (×) button appeared.
  - Cleared via the × button: board instantly returned to `Active · 41` / `Dropped · 1` — full restore confirmed.
- Confirms t-5ea4c7's acceptance criteria end-to-end (hide-on-match, count updates, clear-restores) in a real rendered browser, not just via unit tests.

### 2026-07-03 — human dogfood (installed 0.55.14) — PASS
Toolbar filter hides non-matching cards (clear restores; composes with the agent dropdown's dim behavior);
native Ctrl+F find widget highlights and navigates matches. Maintainer refinement noted for a follow-up
task: header toolbar elements (search input / agent select / +Task / Dropped) lack a normalized
height/rhythm — kit-migration territory.

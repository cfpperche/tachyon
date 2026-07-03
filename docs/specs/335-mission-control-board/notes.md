# 335 — mission-control-board — notes

_Created 2026-07-02._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- **F11 color source ("the sidebar's colors")** — the spec says declared agents should use "the sidebar's
  colors," but there is no existing per-agent/human identity-color system anywhere in the codebase today (the
  sidebar's `.sdot` classes are STATUS colors — running/stopped — not per-agent identity; only the
  `/tmp/mission-control` prototype hardcoded `claude`/`codex`/`human` hexes inline, and that was illustrative,
  not a shipped token set). Resolution: `boardModel.ts` gives EVERY name (declared agent or ad-hoc) the same
  deterministic FNV-1a hash into a small `--vscode-charts-*` categorical palette (already the design system's
  basis for semantic color — theme-aware, no fixed hex), except `human`, which gets one reserved token
  (`--vscode-charts-foreground`) so it never collides with a hashed name. This satisfies the acceptance
  criterion's actual observable behavior (stable across sessions, contrast-checked via the theme, human always
  distinct, never blank/random) without inventing a "sidebar identity color" system the sidebar itself doesn't
  have. If the sidebar later grows real per-agent identity colors, `colorTokenFor` is the one place to swap.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- **No round-trip for chip selection.** The plan's message protocol sketch implied the webview might need to
  ask the host for spotlight/dim state per chip click. In the actual implementation `boardModel.ts` is pure
  and DOM-free (no vscode import), so `mission-control.js` bundles it directly and calls `buildBoardModel`
  client-side on every chip click — the host only ever pushes the raw `BoardSnapshot`. This satisfies "no disk
  reads on chip click" (dueto F4) even more strongly than a message round-trip would (zero IPC too), and keeps
  `boardModel.ts`'s only consumer contract (snapshot → view) identical between tests, the board, and (for
  ordering) nothing else needs to duplicate it.
- **`tachyon.openTaskItem` command dropped.** Originally scaffolded as a VS Code command contribution
  (mirroring `tachyon.openProjectHandoff`), but nothing calls it: `MissionControlPanel` opens the detail panel
  through a directly-injected callback (`openTaskDetail`), and the detail panel's own "open a dep" action
  round-trips through its own webview→host `openTask` message, handled by `TaskDetailPanelManager` itself. A
  registered-but-uninvoked command is dead surface — removed before committing rather than left as a stub.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- **Markdown/CSP hardening tests (dueto F9) without a new `jsdom` dependency.** The spec's acceptance criterion
  wants "unit tests feeding malicious markdown through the renderer." The webview's actual sanitizer
  (`DOMPurify.sanitize`, in `activity/markdown.tsx`) needs a real `window` and cannot be imported in Tachyon's
  node-environment vitest config (confirmed: `require("dompurify")` in plain Node yields a factory with no
  `.sanitize`). Rather than add `jsdom` as a new dev dependency + environment just for this one surface, the
  DOMPurify options (`ALLOWED_URI_REGEXP` etc) were extracted into a new pure, DOM-free module
  (`activity/markdownSanitizeConfig.ts`) that both `markdown.tsx` and `test/unit/markdownHardening.test.ts`
  import. Combined with markdown-it's `html:false` (already proven in `markdownEngine.test.ts` to escape raw
  `<script>`/`<iframe>`/event-handler markup to inert text — the PRIMARY defense), this gives real,
  node-testable coverage of both defense layers the Task Detail body relies on, without a new test-environment
  dependency. `TaskDetailPanel`/`mission-control` reuse the exact same `MarkdownView` component Handoff already
  ships (spec 245) — no new sanitizer code was written for this spec, only a config extraction.
- **Colour-token source for F11 (see the Design decisions entry above)** — resolved a genuinely missing "sidebar
  colors" reference rather than inventing a whole new identity-color system speculatively.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- **Human dogfood + Visual QA are outstanding.** The v1 gate's implementation is done and every acceptance
  scenario has unit-test evidence (see tasks.md's Verification section), so the boxes in spec.md's Acceptance
  criteria are checked — but tasks.md's own "Human dogfood" and "Visual QA" sections are deliberately left
  unchecked: they require an installed VSIX + a human driving VS Code's actual UI (dragging cards, watching a
  live push, reading rendered colors/spotlight/toasts), which this delivery could not execute headlessly. Per
  the task's own framing, `/sdd close` for spec 335 should wait for that human pass — this note is the pointer
  for whoever picks it up next. Owner: maintainer (human dogfood is explicitly a human step per tasks.md).

## Design dueto (probe codex, adversarial-review, 2026-07-03, runId probe-97f2d13a)

First probe attempt failed usefully: the probe sandbox cannot read files, so the spec text must be embedded
inline in the task prompt (remember for future duetos). Re-run returned 12 findings; disposition:

- **F1 (BLOCKER, rank rebalance needs multi-task writes)** — ACCEPTED. Rebalance execution is store-owned
  (atomic under the mutation lock), midpoint minting stays pure. Whole reorder feature moved to a gated v1.1
  criterion; drag-to-reorder is inert until its gate is green.
- **F2 (BLOCKER, concurrent mints across windows)** — ACCEPTED. CAS expect on the dragged task + collision
  check in the lane; stale reorders fail closed with a retry toast. Non-goal reworded: collisions are
  rejected, never last-write merged.
- **F3 (MAJOR, stale neighbors mid-drag)** — ACCEPTED, generalized to ALL drags (status drags too): pushes
  arriving mid-drag are queued, drop validates against the latest snapshot.
- **F4 (MAJOR, next_task spotlight perf/consistency)** — ACCEPTED via the new "board snapshot" contract:
  one engine-side pass builds TaskView[] + allowedDropStatuses + per-chip next_task results; chip clicks do
  zero disk reads. (Rebutted only the scale framing — real fleets have ~6 chips, not 25 — but the
  consistency argument stands regardless.)
- **F5 (MAJOR, priority edit invalidates rank)** — ACCEPTED with a lighter mechanism than proposed: the
  board's priority quick-edit composes `{priority, rank:null}` in one update. No store change needed (the
  probe proposed store-side clearing; board-side composition keeps 325 untouched).
- **F6 (MAJOR, snap-back-only UX)** — ACCEPTED. Snapshot carries store-computed allowedDropStatuses;
  illegal columns are non-targets at drag-start. Webview still embeds no rules — affordances are data.
- **F7 (MAJOR, mid-edit refresh loses input)** — ACCEPTED. Edit sessions keyed by (task, field), input
  preserved across pushes, CAS expect{updatedAt} from session start, stale editors require explicit retry.
- **F8 (MAJOR, detail panel lifecycle)** — ACCEPTED. Panels subscribe by task id independent of board
  filters; tombstone state for missing/corrupt tasks; never auto-closed.
- **F9 (MAJOR, CSP + markdown)** — ACCEPTED. Sanitizer requirements + malicious-markdown unit tests are now
  an explicit criterion.
- **F10 (MAJOR, 500-task envelope)** — ACCEPTED. 500-task fixture in model tests + keyed card updates +
  responsiveness dogfood.
- **F11 (MINOR, unknown-name chip colors)** — ACCEPTED. Deterministic hash into a categorical palette for
  unknown assignee/kind strings.
- **F12 (MINOR, scope overload)** — PARTIALLY ACCEPTED. Rank reorder split into the gated v1.1 section as
  proposed. REBUTTED for the detail tab: it stays in v1 — maintainer decision (card click → detail webview),
  and without it `body` is invisible on the board, which guts the surface's usefulness.

## Verification log

### 2026-07-03T03:48:22Z — pass (2/2) — source: tasks.md
- `npm test -- --run test/unit/boardSnapshot.test.ts test/unit/boardModel.test.ts test/unit/taskStore.test.ts test/unit/nextTask.test.ts` — pass
- `npm run typecheck` — pass

### 2026-07-03T03:51:56Z — pass (2/2) — source: tasks.md
- `npm test -- --run test/unit/boardSnapshot.test.ts test/unit/boardModel.test.ts test/unit/taskStore.test.ts test/unit/nextTask.test.ts` — pass
- `npm run typecheck` — pass

## Code review (claude/Fable, 2026-07-03, commits 5e9b7e3..2605b8c)

Verdict: **approved**. Spot-reviewed the risk seams after independent verification (full suite 2096 passed,
both typechecks, /sdd verify --run 2/2 re-run by the reviewer):
- TaskStore/nextTask refactors are exactly the plan's mechanical hoists — 325's tests untouched, one
  authority for transitions (with an exhaustive allowedTransitions-vs-assertTransition parity test) and one
  comparator shared with the board.
- boardSnapshot is genuinely one-pass (listViews once, pure nextTask per chip against the same derived map)
  with a TaskStore.next() parity test — dueto F4 honored.
- resolveDrop composes CAS expect{status, updatedAt} from drag start and distinguishes noop/stale/reject/
  commit — dueto F3 honored, decisions pure and unit-tested.
- Markdown hardening extracted MarkdownView's DOMPurify options into a testable config (no behavior change
  to activity/handoff, same regexp) + malicious-payload tests; both new panels assert the standard CSP.
- extension.ts wiring: mutual openTask ↔ refreshBoard closure, onViewsChanged("tasks") fans out to both
  managers, command + sidebar button + i18n (en/pt-br) present.
Remaining before close: human dogfood + visual QA on an installed build (steps in tasks.md).

## Dogfood log

### 2026-07-03 — human dogfood round 1 (installed 0.55.1) — FAIL (5 findings)
Board core works (drags with affordances, fail-closed assignee gate, spotlight, SDD derived chip, dropped
toggle, chip union incl. ad-hoc hash colors — screenshots in .tachyon/evidence/spec335-board-*.png), but the
maintainer's pass surfaced 5 real defects:
1. **Detail tab does not live-sync board-side mutations** (spec violation: "reflects live task mutations").
   Root cause: engine-side `taskStore.update` calls from the panels do NOT flow through the bridge's
   onTasksChanged — MissionControlPanel refreshes itself, TaskDetailPanel.refreshAll is only wired to MCP
   mutations. Cross-panel sync must fan out through ONE path.
2. **Stale-marker logic wrong in detail**: a single CAS failure flags BOTH priority and assignee, the flags
   are sticky component state that never clears when a fresh vm arrives, and the "refresh" link only clears
   the flag (doesn't re-fetch). Spec's F7 wanted per-field staleness for in-flight edits only.
3. **Spotlight tag clipped**: the "▶ next_task(agent)" ::after at top: -9px is cut by the column's overflow
   container (prototype had it floating above the card).
4. **Native `<select>` unthemed** (white background in dark theme) in card quick-controls and detail.
5. **Agent chip row doesn't scale**: unbounded inline union (every ad-hoc assignee ever = permanent chip)
   will break the header; maintainer: "essa lista quando crescer vai quebrar facilmente, UX péssima".

### 2026-07-03 — round 1 remediation (5/5 findings fixed, separate commits)

All 5 findings fixed one-at-a-time, each its own `fix(spec-335):` commit; full suite (2108 tests) + both
typechecks green after every commit. Decisions:

1. **`ebcddf1`** — the fan-out root cause was structural: `MissionControlPanel` and `TaskDetailPanel` each
   mutated `ws.taskStore` directly and refreshed themselves with a partial closure (a workspace-scoped
   self-refresh, and a board-only `refreshBoard`). Fix: extension.ts now builds ONE `onTasksChanged` callback
   (`missionControlPanels.refreshAll() + taskDetailPanels.refreshAll() + sidebarProto.refresh()` — the exact
   body `onViewsChanged("tasks")` already ran for MCP-driven mutations) and injects it into BOTH panel
   managers' constructors; they call it after every successful `update`/`create` instead of the old partial
   closures. `onViewsChanged("tasks")` now calls the same function, so there is exactly one fan-out path
   regardless of which side (MCP tool, board, or detail tab) mutated the task.
2. **`7585072`** — extracted a pure `reduceDetailStale` reducer (`task-detail/interactions.ts`, mirrors
   `mission-control/interactions.ts`'s DOM-free-decision convention) driven by explicit events
   (`submit`/`clearField`/`error`/`vmPush`) instead of ad-hoc booleans: an `error` event stales only
   `state.pendingField` (never the other field), and a `vmPush` event (now actually live end-to-end thanks to
   #1) unconditionally clears both markers — a fresh push means the screen already reflects the current task,
   so an old stale flag is moot. The "refresh" link now also calls `dispatch.refresh()` instead of only
   dismissing the flag locally. 8 new unit tests on the reducer.
3. **`31fd98c`** — CSS-only: `.col-body`'s top padding was ~2px, not enough room for `.next-tag`'s
   `top: -9px` offset to render inside the scrollable padding-box when its card is first in the column, so
   `overflow-y: auto` clipped it. Padding bumped to 14px; tag still floats above the card exactly like the
   prototype, just no longer past the scrollbox's own edge.
4. **`ff8f830`** — CSS-only, in the SHARED `design-system.css` (linked by every webview) rather than a
   per-panel override: new `--ds-dropdown-bg`/`--ds-dropdown-fg` tokens (same `--vscode-dropdown-*` fallback
   pattern as `--ds-input-bg`/`fg`) plus one themed `select` rule. Fixes both reported instances (board card
   quick-edit, detail tab priority select) from a single place, and incidentally fixes the same unthemed-select
   bug in `agent-studio`/`plugins`, which had it too but weren't part of this dogfood pass.
5. **`b47cb07`** — `buildBoardModel` now splits `snapshot.chips` into `chips` (declared agents + `human`,
   bounded by workspace config) and `chipOverflow` (ad-hoc assignee strings, unbounded by construction). The
   header renders the bounded set inline and the overflow set behind a "+N more" toggle with its own
   bounded/scrollable panel (`.agents-overflow-panel`, max-width/max-height + its own scrollbar) — forced open
   when the currently-selected filter is itself an overflow chip, so an active ad-hoc filter is never hidden.
   2 new `buildBoardModel` tests cover the split (including the empty-overflow case).

spec.md amended: the "next_task spotlight" scenario documents the chip split (#5); the "live refresh" scenario
now names the shared `onTasksChanged` fan-out explicitly and says Task Detail panels too, not just Mission
Control (#1); the "task detail view" scenario gets a sub-bullet for per-field staleness (#2). #3/#4 are
CSS-only implementation details of the existing "visual language follows the prototype" criterion — not
separately called out as acceptance criteria.

Not done in this pass (explicitly out of scope per the remediation brief): rank reorder (still v1.1-gated,
untouched), and a full re-run of Visual QA / a second human dogfood pass on the fixed build — the maintainer
should re-dogfood before `/sdd close`.

### 2026-07-03T14:10:41Z — pass (2/2) — source: tasks.md
- `npm test -- --run test/unit/boardSnapshot.test.ts test/unit/boardModel.test.ts test/unit/taskStore.test.ts test/unit/nextTask.test.ts` — pass
- `npm run typecheck` — pass

### 2026-07-03 — human dogfood round 2 (installed 0.55.2) — FAIL (5 findings)
Round-1 fixes verified working (live board↔detail sync on drags, spotlight tag intact, themed priority
select, chips collapsed) — but the pass surfaced 5 more:
1. **Assignee edit in the detail tab still demands a manual refresh**: after submitting an assignee the
   ASSIGNEE field flips to the "board changed refresh" stale marker instead of showing the fresh value —
   the per-field stale reducer is misfiring on a SUCCESSFUL submit path (in-flight marking vs vm-push
   ordering). Needs a unit test reproducing submit→success→push before the fix.
2. **Toast placement off-pattern**: project toasts appear bottom-CENTERED (see the Plugins view); the
   board's toast renders as a floating blue box elsewhere. Reuse the house toast style/position.
3. **"+ + task" button STILL doubled** — reported in round 1 (maintainer screenshot) but lost from the
   round-1 fix list during consolidation (reviewer's mistake, recorded for honesty). Icon and label both
   render a plus; keep one.
4. **Board doesn't fill available height**: columns end at their content, leaving the horizontal scrollbar
   mid-screen. The board must occupy 100% of the view height with full-height columns regardless of card
   count, scrollbar pinned to the view's bottom edge.
5. **Agent filter: ONE dropdown** (maintainer decision, supersedes the round-1 inline+overflow design):
   replace the chip row entirely with a single dropdown holding all filter options (declared, human,
   ad-hoc assignees — dots/colors preserved inside the dropdown).

### 2026-07-03 — round 2 remediation (5/5 findings fixed, separate commits)

All 5 findings fixed one-at-a-time, each its own `fix(spec-335):` commit; full suite (2111 tests) + both
typechecks green after every commit. Root causes:

1. **`afe12fa`** — two compounding bugs, not one. (a) `task-detail/App.tsx`'s assignee editor calls
   `submitAssignee()` on Enter, then immediately hides the `<Input>`; unmounting a still-focused element
   fires a native `blur`, and the same `onBlur={submitAssignee}` handler re-invoked `submitAssignee()` a
   SECOND time with the identical (now stale) `expect.updatedAt` closure — a duplicate request that always
   loses its CAS check right after the real one succeeds. (b) `reduceDetailStale`'s `vmPush` case cleared
   `priorityStale`/`assigneeStale` but left `pendingField` untouched, so when the duplicate request's late
   error arrived AFTER the real push, the reducer still had `pendingField: "assignee"` from the original
   submit and re-staled a field the screen had already gone live on. Fixed both: a re-entrancy guard
   (`assigneeHandled` ref, reset on begin-edit, set on Enter/Escape) stops the duplicate request from ever
   being sent, and `vmPush` now also clears `pendingField` so even a late/duplicate response can no longer
   resurrect a stale marker. New reducer test reproduces submit → vmPush → late-error before the fix
   (test-first, at the pure-reducer level — no DOM needed since the symptom is fully reproducible in
   `reduceDetailStale`'s event sequence alone).
2. **`2e1d475`** — CSS/JSX only: `mission-control.css`'s `.toasts`/`.toast` used a bottom-right floating
   box with no relation to the house pattern already shipped in `plugins.css` (bottom-CENTERED, card
   background, error-tinted border). Copied the position/shape, kept the existing array-based stack (the
   board can raise more than one rejection at once, unlike Plugins' single-slot toast) and added the
   matching error icon.
3. **`67d903d`** — per round 2's own dogfood log (finding #3): the maintainer flagged this by screenshot
   during round 1, but it never made it into round 1's written 5-finding list, so it went unfixed and
   resurfaced in round 2 (recorded as a reviewer's consolidation mistake, not a regression). Trivial once
   found: `<Button icon="add">+ task</Button>` renders the codicon plus AND a literal "+" in the label — two
   pluses. Label is now just "Task".
4. **`3f0def7`** — the shared webview shell (`shared/shell.ts`) emits a bare `<div id="root">` with no
   height rule; `mission-control.css`'s `.mc-root { height: 100% }` therefore resolved against an unsized
   parent and collapsed to content height (a CSS percentage-height against an auto-height ancestor resolves
   as `auto`), so columns ended at their content and the board's horizontal scrollbar sat wherever the
   shortest column ended instead of the view's bottom edge. `sidebar.css` already carries the fix for the
   same shell (`#root { height: 100%; min-height: 0; display: flex; flex-direction: column; }`) — mirrored
   here rather than touching the shared shell (which is used by every converted surface, most of which don't
   need a filled-height root).
5. **`f72cfb6`** — not a bug fix so much as a maintainer-directed design reversal: round 1's inline-chips-
   plus-"+N more"-overflow-panel (dogfood round 1, #5) was judged to not scale in practice ("essa lista
   quando crescer vai quebrar facilmente" carried over into round 2 as "replace it with one dropdown").
   `boardModel.ts` gained `agentFilterOptions()`, a pure DOM-free flatten of `chips`/`chipOverflow` into one
   ordered list (bounded set first in its existing order, then ad-hoc entries alpha-sorted); `chips`/
   `chipOverflow` themselves are untouched — still the model's bounded/unbounded split, just no longer
   rendered as two separate UI affordances. The webview now renders a single `<select>`, colored per
   `<option>` via its `colorVar` to preserve the chip row's dot/color identity. 2 new `agentFilterOptions`
   tests cover the ordering (including the empty-overflow case).

spec.md amended: the "next_task spotlight" scenario's chip-overflow sub-bullet now describes
`agentFilterOptions()` and the single dropdown, explicitly superseding round 1's inline+overflow chip design.
#1–#4 are implementation details of existing acceptance criteria (live refresh / per-field staleness / visual
language) — not separately called out as new criteria.

Not done in this pass (out of scope): rank reorder (still v1.1-gated, untouched), and a third human dogfood
pass — the maintainer should re-dogfood before `/sdd close`.

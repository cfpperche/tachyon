# 304 — sidebar-adhoc-parent-grouping — plan

_Drafted from `spec.md` on 2026-06-30. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add one new pure function, `groupByParent`, alongside `sortRows` in `src/sidebar/sortRows.ts` (spec 240's rule: decision logic stays out of the webview layer so it's unit-testable — `sortRows.ts`'s own header comment already states this). `Panel`'s Agents branch (`src/webview/sidebar/App.tsx:223`) runs the existing `sortRows()` first (unchanged — still the single source of A–Z/Z–A ordering), then pipes the result through `groupByParent()` before mapping to `<AgentRow>`. The Terminals branch (`:229`) is untouched — terminals have no `parent` concept.

`groupByParent` walks the already-sorted array once and re-emits it depth-first: each row with no parent (or a parent not present in the current row set — an orphan, e.g. the parent already exited) is emitted, immediately followed by its children (rows whose `parent` matches its `name`), recursively, in their existing sorted relative order. A `visited` guard marks each row as emitted so depth-first descent never re-emits it. **(Folded from the design dueto, finding 1):** that root-first pass alone is not enough — if every row in a cycle has a *present* parent (no row qualifies as a top-level root to start from), the naive algorithm silently drops the whole cycle, contradicting the "same length, same set of rows" guarantee. So after the root-first depth-first pass, a final cleanup pass appends any row that is still unvisited (i.e. only reachable via a cycle) in its original sorted order. This is pure defensive coverage — a lineage cycle should never occur in practice — but it makes "no row is ever dropped" an actual invariant instead of an assumption.

This keeps `sortRows` itself untouched (still a generic, name-only, pure sort reused by both Agents and Terminals — spec 242's contract holds), adds grouping as a separate composable step, and keeps the existing `↳`/"spawned by" rendering in `AgentRow` (`App.tsx:96-114`) exactly as-is — only list order changes.

## Key decisions

- **A separate `groupByParent` function composed after `sortRows`, not a `getParent` option baked into `sortRows` itself** — chosen because `sortRows` is shared by Terminals (no `parent` field) and spec 242's header explicitly documents it as a generic, name-only sort; folding parent-awareness into its signature would force every caller to pass a no-op `getParent` and blur "sort" with "group". Rejected: extending `sortRows`'s signature with an optional `getParent` callback — more parameters on a function whose contract is deliberately minimal, for a need only one of its two callers has.
- **Depth-first recursive emission (parent, then its children, recursively) over a single flat one-level splice** — chosen because it costs nothing extra and degrades safely if an ad-hoc agent ever spawns its own ad-hoc child (a 2-level chain), even though the spec's acceptance criteria only require and test one level. Rejected: hard-coding exactly one level — would silently misplace a grandchild the day nested ad-hoc spawning shows up, for no real simplicity gain. **(Folded from the design dueto, finding 2):** the recursion is kept as a *defensive implementation detail with no acceptance/dogfood promise* — `spec.md`'s non-goal now says explicitly that depth ≥2 behavior isn't a tested contract. The depth-2 test in this plan's test list is relabeled accordingly (robustness coverage, not an acceptance scenario), so the test suite doesn't quietly expand the spec's contract past what the non-goals declare.
- **A final unvisited-rows cleanup pass closes the cycle gap** — chosen because the root-first depth-first walk has no entry point into a cycle where every member has a present parent; appending leftover unvisited rows in their original sorted order after the main pass guarantees no row is ever silently dropped, at the cost of one extra O(n) scan. Rejected: a recursion-depth/iteration cap that just stops early — would still drop rows, only quieter about it.
- **Orphaned children (parent not present in the current row list) stay in their normal alphabetical position, not pinned to the top or bottom** — chosen to match the spec's explicit "degrades gracefully" acceptance scenario and because it requires no special-casing: a row whose parent isn't found is just never claimed by the children pass, so it naturally falls out in the top-level pass at its sorted position. Rejected: sorting orphans to the end — adds a rule for a transient case (parent already exited) without a clear benefit.
- **No new collapse/expand affordance or group header for parent/child clusters** — chosen because spec 242 deliberately flattened the list (no status sections); this spec is ordering-only and must not reintroduce a grouping UI spec 242 removed. Rejected: a collapsible "show children" toggle — out of scope per spec.md's non-goals, and not asked for in the originating bug report.

## Files touched

- `src/sidebar/sortRows.ts` — add `groupByParent<T>(rows, getName, getParent)` (root-first depth-first emission + a final unvisited-rows cleanup pass for cycle safety), exported alongside `sortRows`/`asSortMode`. **(Folded, finding 3):** update the module's header comment when adding this — it currently describes the file as only "the pure, node-testable sort," and should say it also holds the parent-grouping step so a future reader isn't misled about `sortRows()` itself gaining parent-awareness.
- `src/webview/sidebar/App.tsx` — `Panel`'s Agents branch (`:223-224`) composes `groupByParent` after `sortRows`; Terminals/Pipelines/Schedules branches unchanged. *(Dueto: no objection — this keeps decision logic out of the webview layer per spec 240, doesn't touch Terminals' shared `sortRows()` path.)*
- `test/unit/sortRows.test.ts` — new cases for `groupByParent`: child sorts after parent, multiple children keep relative order, orphaned child stays in place (both sort directions), no mutation, **a lineage cycle (required — covers finding 1 / the new cycle acceptance scenario)**, and a depth-2 chain (defensive/robustness coverage only per finding 2 — not asserting a contractual acceptance scenario).

## Risks & unknowns

- **R1 — `AgentVM` doesn't currently expose enough to unit-test through `App.tsx`.** Mitigation: keep `groupByParent` pure and generic (same shape as `sortRows`) so it's tested directly in `sortRows.test.ts` with plain `{name, parent}` fixtures, same pattern as the existing suite; `App.tsx`'s wiring is a one-line composition, low-risk to leave to manual/dogfood verification.
- **R2 — performance on large fleets.** The depth-first walk is O(n²) worst case (a children-scan per emitted row). Tachyon agent lists are small (single/low-double-digit count per workspace); not a real concern, but worth a one-line comment so a future reader doesn't assume it's O(n).
- **R3 — interaction with `flashName`/key stability.** `AgentRow`'s `key={a.name}` is unaffected by reordering (Preact keys by value, not position), so a reorder should not cause remount/flash artifacts — but this is worth confirming visually in the dogfood step since it's a Preact behavior, not something `sortRows.test.ts` can prove.

## Sources consulted

- `src/sidebar/sortRows.ts` — current sort contract, spec 240/242 header comments.
- `src/webview/sidebar/App.tsx:215-230` (`Panel`), `:96-114` (`AgentRow`) — render/order call sites and existing `↳`/"spawned by" markup.
- `src/webview/sidebar/sidebar.css:97-98` — `.row.child` indent glyph rule.
- `src/sidebar/agentModel.ts:7-14,44-67` (`AgentRaw`, `toAgentVM`) — confirms `parent` is already passed through to the view model.
- `test/unit/sortRows.test.ts` — existing test shape/conventions to extend.
- Pin `p-b0755f` (screenshot) — the reported symptom.
- `docs/specs/242-*` (referenced in `sortRows.ts`/`App.tsx` comments) — the flat-list, no-status-headers decision this spec must not reverse.
- Ad-hoc `codexDueto304` review agent (gpt-5.5 medium) — design dueto on this plan, 2026-06-30.

## Design dueto (SHIP-WITH-CHANGES) — folded

Codex reviewed this plan + `spec.md` plus the cited source/test files. Verdict: **SHIP-WITH-CHANGES**.

- **Finding 1 (required, folded above)** — the root-first depth-first algorithm as originally described has no entry point into a true cycle (every member has a *present* parent), so it would silently drop the whole cycle despite the plan's "same length, same set of rows" claim. Fixed: added a final unvisited-rows cleanup pass + a new cycle acceptance scenario (`spec.md`) and a required cycle test.
- **Finding 2 (required, folded above)** — the plan's depth-2 test obligation expanded the contract past `spec.md`'s stated non-goal ("only one level... in scope"). Fixed: the non-goal now explicitly says deeper chains are handled defensively but aren't a tested contract; the depth-2 test is relabeled as robustness coverage, not an acceptance scenario.
- **Finding 3 (suggested, folded above)** — flagged that `sortRows.ts`'s module header would mislead a future reader once it also hosts `groupByParent`. Folded into the Files-touched note.
- **No objection** — composing `groupByParent` after `sortRows` in `App.tsx` (rather than baking parent-awareness into `sortRows` itself) does not violate spec 240's "decision logic stays out of the webview layer" rule, since the grouping logic itself still lives in `src/sidebar/`.
- **No objection** — orphan-stays-in-sorted-position matches the acceptance criteria and doesn't reintroduce any spec-242 grouping UI.

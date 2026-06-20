# Design direction — Activity feed perf + Tier 2 polish (spec 238)

**UI impact:** ui — changes the rendered Activity surface. Done-proof: EDH visual validation + `activity-preview.mjs` + unit tests (no web e2e runner for a VS Code webview; this is the native-surface honest-evidence path, not a UI-test proof of motion).

**Surface:** the Activity WebviewPanel feed. **Mode:** refine (bounded diffs, preserve behavior). **Stack rung:** 1 (existing Preact webview + inline CSS).

## The feel

A cockpit, not an archival reader. Recent activity is instant and cheap to paint; older history is reachable but never blocks the live tail. Nothing is dropped *silently*. Polish that earns its place: find a line, see an image full-size, read cost when the runtime gives it to us — and nothing that turns Tachyon into a pricing oracle or a scroll-math liability.

## Decisions (Claude + Codex consensus; my refinements noted)

### 1. Perf — `content-visibility:auto`, NOT measured virtualization
Ship `content-visibility:auto` + kind-aware `contain-intrinsic-size` on feed items. The browser skips layout/paint of offscreen subtrees with **zero** change to the postMessage protocol, window-scroll model, or bottom-stick logic. Rejected measured virtualization (TanStack-style) for v1: reverse-chat + async post-mount height (mermaid/katex) + window-scroll + bottom-stick at once is the documented high-risk path.

**My refinement over codex:** apply `content-visibility:auto` **only to items outside the live tail** (e.g. all but the last ~30). The active tail stays fully rendered so bottom-stick height math is exact and the EDH bite (lazy mermaid/katex resolving near the bottom while the user is slightly scrolled up) can't shift the anchor. Offscreen older items — where wrong intrinsic-size only causes mild scrollbar drift, never an anchor jump — get the cheap path.

Not "solved" until EDH profiles a worst-case ~600-item feed (many mermaid/code/image subtrees) for memory. Node count is unchanged by content-visibility; if memory is the ceiling, windowed-tail + host pagination (deferred option A) is the follow-up — gated on evidence, not assumed.

### 2. The 600-item cap becomes VISIBLE (kills the silent drop)
Add a header/top-of-feed notice when `summary` count > rendered items: **"Showing recent N of M — Open transcript for full history"**, wired to the existing Open-transcript action. The cumulative summary (tokens/counts) already survives the trim, so totals stay honest. Keep the cap (it's host-side safety); do NOT remove it and lean on virtualization (that couples correctness to a perf mechanism). Host-side backward pagination is deferred until in-panel old-history is a validated need — the Open-transcript escape hatch + visible scope is sufficient for a cockpit.

### 3. Tier 2 polish
- **Search/filter — client-side over the loaded window.** A header search box filters/highlights the rendered items; the box label states the scope explicitly ("search recent activity") so "600 of 16k" never silently misleads. No host-side full-transcript indexing in this pass.
- **Cost in $ — only from transcript-provided fields.** Render `$` solely when the transcript/view-model already carries a cost field (e.g. claude `costUSD`); otherwise keep tokens in/out as today. No baked per-model pricing tables — they drift, are runtime/model-specific, and contradict the project's no-frozen-stack-opinions rule. Inaccurate cost is worse than absent cost.
- **Image click-to-zoom — ship.** Pure webview lightbox (overlay + Escape/click-out to close, focus handling); no protocol change. CSP already allows `img-src cspSource data:`.

### Codex's 4th option — semantic compaction — already largely present
Codex proposed collapsing old thinking/tool detail by default. The view already does this: thinking is collapsed by default, tool chips show a one-line summary that expands on demand, long messages clamp. So the compaction is mostly in place; `content-visibility` covers the residual offscreen paint. No new collapse mechanism needed — noted, not built.

## Sequencing (each = one increment: implement → codex review → EDH validate → commit)
1. Visible "recent N of M" cap notice (smallest, removes a rule violation).
2. `content-visibility:auto` + kind-aware intrinsic sizes, tail-excluded. **EDH memory + scroll-anchor profiling here.**
3. Client-side recent-window search (scope-labeled).
4. Image lightbox.
5. Cost-from-transcript-field (gated; verify whether claude records carry it first).
6. (Deferred) windowed-tail + host pagination — only if step-2 EDH proves memory, not paint, is the ceiling.

## Stop criteria
Each increment stops when: EDH shows the intended improvement, behavior preserved, diff bounded, unit/preview evidence green. Perf increment additionally stops only after a worst-case ~600-item EDH profile. Max 4 critique iterations/increment.

## Status (2026-06-20)

Increments **1–4 implemented** in one diff (`activityView.ts` + `ActivityPanel.ts` CSS + `App.tsx` + `main.tsx`); typecheck (both configs) clean, build OK, 783 unit tests green (incl. new `totalItems` assertion), `activity-preview` renders a real 13.8k-record transcript. **Codex review: SHIP-WITH-CHANGES** (`.agent0/.runtime-state/codex-exec/20260620T213245Z-code-review-activity-view-perf-tier-2-polish-tac/`); all 3 findings folded:
- MAJOR (search re-lowercased multi-MB tool bodies per keystroke) → memoized lowercased index keyed on `vm.items` + `resultFull` capped at 2000 chars (`SEARCH_BODY_CAP`).
- MINOR (cvCut counted day separators → live tail < 30) → `cv` now decided in item space via monotonic `sequence` (`tailFromSeq`).
- MINOR (vm update during search yanked scroll) → `query` hoisted to `Root`; bottom-stick effect gated on `!query`.

**Increment 5 (cost in $) — DEFERRED with evidence, not built.** Probed a real claude transcript: records carry only `output_tokens` / `cache_read_input_tokens` — **no `costUSD`/cost field**. With the only current runtime emitting no cost and baked pricing tables ruled out, the feature would render nothing today; building dead plumbing is speculative. Revisit when a runtime that emits cost lands (ties to the deferred multi-runtime work). Tokens in/out stay in the header.

Pending: **EDH visual validation** (the user's half of the loop) — worst-case ~600-item feed scroll-up through `content-visibility` items; search jank; lightbox; cap-notice click.

## Out of scope
Multi-runtime normalizers (deferred until claude is 100% satisfactory — user directive 2026-06-20); measured virtualization; host-side transcript search/indexing; pricing tables.

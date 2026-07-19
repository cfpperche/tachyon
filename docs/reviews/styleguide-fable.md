# STYLEGUIDE review — fable

Reviewed: `docs/STYLEGUIDE.md`, `docs/plans/unified-webview-design-system.md`, `src/webview/shared/ui/{README.md,patterns.tsx,index.ts}`, `src/webview/shared/design-system.css`, `src/webview/cockpit/App.tsx` (+ its `cockpit.css`), `src/webview/approval/App.tsx`, `src/webview/validations/App.tsx` (+ `.css`), `src/webview/runtime-ops/App.tsx`, `test/unit/webviewComponentKit.test.ts`.

Method: read the contract, then checked it against the actual code shipped alongside it in 0.56.61 — not against the plan's aspirational Phase B/C/D checkboxes. Every finding below cites a real file/line. This is a critique of the **document** (gaps, contradictions, weak rules); the code drift is evidence for *why* the document needs to change, not a bug list — filed separately where it's a bug rather than a doc gap.

**Overall assessment:** the token layer (`design-system.css`) and the primitive layer (`Button`/`Badge`/`patterns.tsx`) are solid and genuinely single-source. The document's weakness is entirely at the *authority* layer: it states rules with no enforcement path, and in one place (Control tab bodies) states a rule that formally licenses the divergence it's trying to end. The real adoption numbers make this concrete: repo-wide, `PageChrome` is imported in **2** files, `ListRow` in **1**, `EmptyState` in **1** — for a document whose opening line calls itself "Single design system for every Tachyon webview."

---

## P0 — contract says one thing, ships another

### P0-1. STYLEGUIDE names ListRow's use cases verbatim; the named surfaces don't use it
**Problem:** The Required Authoring API table (STYLEGUIDE.md:69) lists ListRow for "Dense list row (**fleet, tasks meta, worktrees**…)" — naming Control's Fleet/Worktrees/Deliveries tabs specifically. Those exact tabs (`src/webview/cockpit/App.tsx:389,453,493`) hand-roll `<article class="ck-entity-card">` / `.ck-entity-title` / `.ck-entity-meta` / `.ck-entity-actions` / `.ck-pill` instead — a parallel row component with its own CSS in `cockpit.css:757-827`. Repo-wide, `ListRow` is imported in exactly one file (`sidebar/App.tsx`).
**Why it matters:** when the guide's own worked example isn't followed by the code that shipped with it, the rule reads as aspirational rather than binding — the next author copies `ck-entity-card`, not `ListRow`, because that's what's actually in Control.
**Fix:** Either (a) migrate Fleet/Worktrees/Deliveries to `ListRow` as part of landing this doc revision, or (b) if `ListRow` genuinely can't fit `ck-entity-card`'s richer body (path row, multi-action footer), say so in STYLEGUIDE and extend `ListRowProps` (e.g. a `footer` slot) rather than leaving the table's own example unmet.

### P0-2. Validations is named a "priority pilot" and has zero shared/ui imports
**Problem:** STYLEGUIDE's Migration section (line 111) and the plan (line 26) both call out "Control + Approvals/Validations → priority pilots for chrome + buttons (**highest inconsistency pain**)." `src/webview/validations/App.tsx` imports nothing from `shared/ui`: it reimplements `Icon` locally (line 6, duplicating `shared/ui/Icon` exactly), builds its own header (`<header class="validation-title"><h1>Validations</h1>…`, line 65) instead of `PageChrome`, and uses raw `<button>`/`<select>`/`<textarea>` throughout instead of `Button`/`Select`/`Textarea`. Its stylesheet (`validations.css`) uses `var(--vscode-*)` directly **7 times** and `var(--ds-*)` **0 times**, and hardcodes `font-size: 20px` for its title (line 4) against STYLEGUIDE's "one panel-title size everywhere: 16px" and a hardcoded `border-radius: 4px` (line 6) against "**`--ds-radius` only** (6px)."
**Why it matters:** Approvals (same "priority pilot" line) is a good pilot — `PageChrome`, `Button`, `EmptyState`, `IconButton` all present (`approval/App.tsx:79-95`). Validations sitting right next to it at zero adoption, while both are labeled "priority pilot" in the same sentence, means the label carries no information about what's actually done.
**Fix:** Split the "priority pilot" claim in STYLEGUIDE/plan into per-surface status (done / in progress / not started) instead of a bundled "Approvals/Validations" pair, so the doc can't claim credit Validations hasn't earned. Concretely: `docs/plans/…md`'s Phase B item 1 should not read as one bullet for both surfaces.

### P0-3. Status/badge vocabulary is not unified, contradicting the plan's own Phase E goal
**Problem:** The plan states a goal of "Single status vocabulary" (Phase E). Today at least three parallel status-chip implementations ship concurrently: `Badge` (`shared/ui/Field.tsx`, tones `default|ok|warn|err|info`), `ci-badge` (`cockpit.css:625-647`, states `attached|error|none`, its own CSS not composing `.ds-badge`), and `ck-chip.ok/.warn` (`cockpit.css:302-330`, Overview's KPI chips). STYLEGUIDE's Review checklist even asserts "Status via `Badge` tones" (line 124) as a PR gate, but nothing in the repo enforces it and the surface that ships alongside the doc violates it in two different ways.
**Why it matters:** three status vocabularies means three places to update when a new state (e.g. "degraded") is added, and three different visual treatments for what a user reads as the same concept.
**Fix:** Add a line under Components: "`ci-badge`/`ck-chip` status modifiers are retired; all status chips render via `Badge`." Then either fold `StateBadge`/Overview's KPI chips into `Badge` (extending `BadgeTone` if it's missing a value Control needs) or explicitly scope an exception in the guide with a reason (e.g. "KPI count chips are not status and are out of scope for Badge") — right now the guide is silent on which of the two is intended, so both readings coexist in the same file.

### P0-4. The Phase D enforcement guard excludes exactly the surfaces named as priority pilots
**Problem:** `test/unit/webviewComponentKit.test.ts`'s `MIGRATED_VIEWS` allowlist is `["handoff", "inspector", "activity", "pin-studio", "plugins", "probes", "pin-preview", "sidebar"]`. It does not include `cockpit`, `approval`, `validations`, `runtime-ops`, `mission-control`, or `control-inspector` — i.e., every Control-family surface, which is exactly what STYLEGUIDE calls the "highest inconsistency pain" priority. STYLEGUIDE's own Migration bullet 5 hedges this with "…where enforced" (line 114), which is technically accurate but reads as a minor caveat when it actually means *the guard covers none of the surfaces the doc prioritizes*.
**Why it matters:** a "forcing function" that skips the highest-priority surfaces isn't forcing anything there — it's a green checkmark on the low-risk 80% while the acknowledged hot spot keeps drifting with no test able to catch it.
**Fix:** Change STYLEGUIDE line 114 from "Guards: kit/convention tests ban new hand-rolled `.ds-btn` markup and hard-coded row selection colors where enforced" to name the gap explicitly, e.g.: "Guards: `webviewComponentKit.test.ts` enforces `MIGRATED_VIEWS` only (see file); **Control/Approvals/Validations/Runtime Ops are not yet in that allowlist** — until they are, this guide is not a build-time gate for the surfaces it prioritizes." That one sentence turns a silent gap into a tracked, visible one — which is the standard this repo holds product invariants to (see `docs/architecture/product-invariant-testing.md`'s "no silent caps" principle) and should hold its own design-system guardrail to.

---

## P1 — real gaps and self-defeating rules

### P1-1. The Control tab-body rule has a built-in escape hatch from the thing it's trying to enforce
**Problem:** STYLEGUIDE.md:103 — "Tab bodies: either native `ck-*` **or** embed wrapped so titles/actions use PageChrome." The "either/or" means any tab can opt out of `PageChrome` by staying "native `ck-*`," with no criterion for when a tab counts as native vs. should-be-migrated. Overview (`cockpit/App.tsx:262-283`) is the concrete instance: hand-rolled `<h1>`/`.hint`/`.ck-overview-actions`, and it's compliant with the rule as written, even though it's a full page header that `PageChrome` was built for.
**Why it matters:** a rule with a universal escape clause can't drive convergence — it can only ratify whatever the author already chose. This is the single biggest reason PageChrome adoption is at 2 files repo-wide five components in.
**Fix:** Replace with a criterion, not a binary choice: "Tab bodies with a title + hint + actions row use `PageChrome`. `ck-*` native markup is reserved for tabs with no title row at all (e.g. a pure canvas/table with no chrome)." Then call out Overview by name as needing migration in the plan's Phase B (it currently isn't listed there at all — Phase B lists Approvals/Validations, Runtime Ops, Inspector/tmux, Fleet/Worktrees/Deliveries, Board, but never Overview).

### P1-2. No sanctioned Table/DataTable primitive, despite one already existing in the surface STYLEGUIDE ships next to
**Problem:** `cockpit/App.tsx:209-247` (`DataTable`, used by the Engine tab) hand-rolls `<table class="ck-table">` with header/mono-column logic. STYLEGUIDE's Required Authoring API table has no `Table` entry at all — this is a real, present need with no contract answer.
**Why it matters:** the next surface that needs tabular data (Runtime Ops' provider capacity table is a candidate) will either copy `ck-table` or invent a fourth pattern, because the guide gives no name to reach for.
**Fix:** Add a `Table` (or `DataRows`) row to the Required Authoring API table, even if v1 is just `ck-table`'s markup promoted into `patterns.tsx` with `--ds-*` styling. If it's deliberately out of scope for this ship, say so as a non-goal (the guide already has a Non-goals section in the plan; "no shared Table primitive yet — `ck-table` is the interim pattern" costs one line and prevents silent reinvention).

### P1-3. `ButtonVariant` values are undocumented in the contract
**Problem:** `Button.tsx` defines `variant: "default" | "primary" | "danger"`, but STYLEGUIDE's Components section only says "Button — `shared/ui`" with no variant guidance (unlike `Badge`, which documents its tones inline: "`Badge` (`tone`: default | ok | warn | err | info)", line 62). `cockpit/App.tsx` uses `variant="default"` for both neutral actions (Refresh) and primary navigation (10+ "Jump" buttons, lines 335-364) — i.e. every button in Control's densest surface is visually the same weight, with no `variant="primary"` anywhere in the file.
**Why it matters:** without a stated rule for when to reach for `primary` vs `default`, "every button looks the same" isn't a bug — it's the documented contract's silence being followed correctly. If that's intentional (dense Control screens genuinely want flat, non-competing buttons), say so; if not, it's an unwritten hierarchy rule.
**Fix:** Add one line to the Components table: "Button variants — `primary` for the page's single primary action, `default` otherwise, `danger` for destructive. A tab body should have at most one `primary`."

### P1-4. Runtime Ops has no PageChrome and the plan doesn't flag it as behind
**Problem:** `runtime-ops/App.tsx` hand-rolls `<main class="runtime-ops">` with its own summary-item layout, no `shared/ui` imports at all. This is tracked in the plan as Phase B item 2 ("Runtime Ops minimal PageChrome") so it's not a broken promise the way Validations is — but STYLEGUIDE itself makes no mention of Runtime Ops anywhere, so a reader of the contract alone (not the plan) has no way to know this surface is known-behind rather than out of scope.
**Fix:** Minor, but: STYLEGUIDE's Control section should cross-reference the plan's phase list (or at minimum say "see plan for per-surface migration status") so the two documents don't silently diverge on what's covered.

---

## P2 — polish

- **`--ds-disabled-opacity` guidance is unenforced by example.** STYLEGUIDE says "prefer `--ds-disabled-opacity` when present; do not invent per-surface 0.35/0.45/0.5" (line 48), but `design-system.css` itself computes derived opacities inline (`calc(var(--ds-disabled-opacity) * 0.7)` for locked tabs, `* 0.9` for disabled chips, lines 152/160) without naming that pattern as sanctioned. A reader following the letter of the rule might avoid `calc()` entirely. One clause — "derived states may `calc()` off the base token; a bare new numeric opacity may not" — closes the ambiguity.
- **The review checklist has no Control-embed-specific line for the tab-body rule in P1-1.** Once that rule gets a real criterion, add a checklist item: "Control tab body has a title row → uses PageChrome (not hand-rolled `<h1>`)."
- **`shared/ui/README.md`'s migration table already knows the truth STYLEGUIDE doesn't say out loud** — it lists "Other panels | legacy / surface CSS | migrate on touch" but Validations isn't "other," it's the named pilot. Worth reconciling the two docs' migration-status framing so they don't quietly disagree (README implies Validations is unmigrated-and-that's-fine; plan/STYLEGUIDE imply it's a current priority).

---

## Top 5 concrete STYLEGUIDE.md edits (in priority order)

1. **Line 114** — replace "Guards: kit/convention tests ban new hand-rolled `.ds-btn` markup and hard-coded row selection colors where enforced" with an explicit statement of `MIGRATED_VIEWS`' current scope and the fact that Control/Approvals/Validations/Runtime Ops are outside it. (P0-4)
2. **Line 103** — replace the "either native `ck-*` or embed wrapped" either/or with a criterion (has a title/hint/actions row → PageChrome; pure canvas → native). (P1-1)
3. **Line 111** — split "Control + Approvals/Validations → priority pilots" into per-surface status so a fully-migrated surface (Approvals) and a zero-adoption surface (Validations) aren't asserted as one bullet. (P0-2)
4. **Components table (line 69 area)** — add a `Table`/`DataRows` row naming the sanctioned pattern for tabular data, even if v1 just promotes `cockpit/App.tsx`'s existing `DataTable`. (P1-2)
5. **Components table, Button row** — document `ButtonVariant` usage (`primary` = one per page, `default` otherwise, `danger` = destructive), matching the inline-tone convention already used for `Badge`. (P1-3)

---

*Affected Product Invariants: none — this is a documentation review producing no product code change.*

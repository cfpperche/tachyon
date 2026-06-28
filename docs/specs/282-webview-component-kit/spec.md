# 282 — webview-component-kit

_Created 2026-06-28._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** shipped 2026-06-28 — FOUNDATION + first migrated panel (Lane A). NOT "the inconsistency is gone" (8
panels still drift — see the manifest). Delivered: (1) the CSS alignment FIX in design-system.css — `--ds-icon-gap`
token, `.ds-tab` now `inline-flex`+`align-items:center`+gap (THE Agent Studio tab-codicon misalignment), `.ds-btn`
gap→token, a canonical `.ds-chip` (was per-panel chip/schip/tag-chip), and `.ds-btn/.ds-tab/.ds-chip .codicon` fixed
size/`line-height:1`/`flex:none`. (2) The kit `src/webview/shared/ui/` — `cx` (frozen, tested), `Icon`, `Button`
(variant default/primary/danger), `IconButton`, `Tabs` (ARIA tablist + onSelect; App keeps the lock logic), `Chip`,
`Input`/`Textarea`/`Badge`. (3) Agent Studio migrated — tabs/buttons/chips compose the kit; 0 hand-rolled
ds-btn/ds-tab/chip remain; the dead `.chip` removed from agent-studio.css. (4) The enforcement guard
(test/unit/webviewComponentKit.test.ts) — manifest-scoped class-literal scan, kit allowlisted by being outside the
scan, PROVEN to catch an injected `class="ds-btn"` bypass. ALIAS AUDIT: `ds-btn`(Cancel/Browse)=equivalent →
`<Button>`; `ds-btn-primary`(Save, standalone)→`ds-btn ds-btn-primary` with a transparent border = visually equivalent
(intentional: primary now composes ds-btn for structure); the agent-studio `.chip`→canonical `.ds-chip` = equivalent.
VISUAL-EQUIVALENCE proof: harness render — same layout, tab codicons now centred (the fix), Save button identical;
`.ds-tab` computes display:flex + align-items:center + 6px gap. Codex dueto folded (SHIP-WITH-CHANGES). Bundle note:
agent-studio.js 24.1→25.2 KB (+~0.5 KB for the kit); inspector.js unchanged (not yet importing the kit). Verified:
full suite 1730 green (+3), typecheck/build/engine-boundary clean.

**Migration manifest (follow-up lanes — banned-class counts to drive to 0):** pin-studio (25 btns), plugins (16),
sidebar (13), activity (10), inspector (6), handoff (2), probes (0), pin-preview — each a later lane: alias-audit →
migrate to the kit → visual-equivalence → add to MIGRATED_VIEWS so the guard covers it.

> **Origin (owner):** the recurring pain — "the extension's buttons are inconsistent: glyph misaligned with text,
> icon sizes, spacing", worst on the Agent Studio tabs. specs 279/280 unified the webviews onto ONE Preact convention
> + shared shell + a token design system (`design-system.css`: `--ds-*` over `--vscode-*` + `.ds-btn`/`.ds-tab`/…).
> But the design system is CSS CLASSES — nothing forces a panel to use them, so panels hand-roll button/tab markup
> and DRIFT. The survey proves it: `ds-btn-primary` AND `ds-btn primary` (same thing, two spellings) coexist; a chip
> is `chip` here, `schip` there, `tag-chip` elsewhere. The owner's call (chose over Tailwind/shadcn — which are
> React/Radix and fight the deliberate Preact-only webviews): **promote the design system from CSS classes to
> reusable PREACT COMPONENTS over the existing tokens**, so every panel COMPOSES `<Button>`/`<Tabs>`/`<Icon>` and the
> inconsistency becomes impossible by construction. No new deps, no React.
>
> **Codex dueto (2026-06-28) — SHIP-WITH-CHANGES, folded.** Sharpened: (a) the icon-alignment FIX is CSS, the
> component is the DISTRIBUTION mechanism — the canonical baseline/size/gap lives in `design-system.css`
> (`.ds-btn .codicon` / `.ds-tab .codicon` rules + a `--ds-icon-gap` token), NOT hidden in component markup; the
> kit just makes every panel adopt it. CSS owns rendering truth; components own the AUTHORING API. (b) parity is
> NOT byte-equivalent (normalizing `ds-btn primary`→`ds-btn-primary` + `chip/schip/tag-chip`→one is a deliberate
> change) — replace it with an ALIAS AUDIT (map each old spelling → computed CSS intent, mark equivalent vs
> intentional) + a before/after VISUAL-EQUIVALENCE proof (harness render + reviewer checklist), never "byte parity".
> (c) the guard is the PRODUCT (first-class gate), not a nice-to-have — a manifest-scoped string-literal scan + a
> negative fixture proving it fails on a raw `ds-btn`. (d) Agent Studio only = "foundation + first migrated panel",
> NOT "inconsistency impossible" — acceptance adds a MIGRATION MANIFEST (the 8 remaining panels + their current
> banned-class counts) so the thread isn't lost. (e) `cx()` frozen to `(...parts: (string|false|null|undefined)[])`,
> no object syntax. (f) a11y/semantics: Tabs = presentation + `onSelect` + ARIA/focus basics; CLASSIFY the chip
> aliases (chip/schip/tag-chip may differ) before consolidating; preserve focus/title/disabled. (g) a bundle-size
> note after impl.

## Intent

A small Preact component kit (`src/webview/shared/ui/`) over the EXISTING `--ds-*`/`--vscode-*` tokens — the design
system's enforced API. Panels compose components instead of copying class names; the icon↔text alignment, codicon
size, gap, and padding live in ONE place. This fixes the button inconsistency (#2) as a side effect of the migration,
and a guard stops the drift from recurring.

**Not a re-platform.** The components WRAP the existing `.ds-*` token CSS (it stays the implementation); they don't
replace it with Tailwind/scoped-CSS. Lowest-risk: the CSS already renders correctly — the kit just makes its use
typed, composable, and enforced.

## Grounding (the survey)

| pattern | usage | drift evidence | → component |
|---|---|---|---|
| `ds-btn` / `ds-btn-primary` / `ds-btn primary` / `ds-btn danger` | ~21 | **`ds-btn-primary` vs `ds-btn primary`** | **`<Button variant>`** |
| `codicon codicon-*` (a button's icon) | dense (activity 22, inspector 8) | hand-placed, varied size/gap | **`<Icon name>`** |
| `ds-tabs` / `ds-tab` | the Agent Studio tabs (the named pain) | hand-rolled active/locked state | **`<Tabs>`** |
| `chip` / `schip` / `tag-chip` | ~10 | **3 names for one idea** | **`<Chip>`** |
| `ds-input` / `ds-badge` | a few | — | **`<Input>` / `<Badge>`** |

Buttons are everywhere (pin-studio 25, plugins 16, sidebar 13, activity 10…) — `<Button>` + `<Icon>` are the
highest-value pieces; the Agent Studio `<Tabs>` are the owner's specific complaint.

## Design

### The actual alignment fix lives in CSS (folded from Codex)

The glyph-misaligned / icon-size / gap pain is a CSS problem; an `<Icon>` component alone can't fix font metrics. So
`design-system.css` gets the CANONICAL rules (the rendering source of truth):
- button/tab/chip content containers: `display: inline-flex; align-items: center;`
- `.ds-btn .codicon` / `.ds-tab .codicon` / `.ds-chip .codicon`: fixed `font-size`, `line-height: 1`, `flex: none`
  (no shrink), baseline-aligned;
- the icon↔text gap is a token: `--ds-icon-gap` (one value, every component).

The components don't OWN these rules — they apply the semantic structure + variant classes that the CSS targets.
CSS owns rendering truth; the kit owns the authoring API.

### The kit (`src/webview/shared/ui/`)

Typed Preact components — the AUTHORING API, each composing the (now-canonical) `.ds-*` classes so panels stop
hand-rolling markup:
- **`<Icon name aria-hidden?>`** — a codicon span; normalizes the codicon NAME + accessibility only (the size/gap is
  the CSS rule above, not here).
- **`<Button variant="default|primary|danger|ghost" icon? disabled? title?>`** — `<button class="ds-btn …">` with
  `<Icon>` + label; subsumes `ds-btn` / `ds-btn-primary` / `ds-btn primary` / `ds-btn danger`. Preserves
  disabled/title/focus.
- **`<IconButton name title>`** — an icon-only button (consistent square hit area, accessible label via `title`).
- **`<Tabs items active onSelect>`** — the tab row (icon + label + active/locked state); presentation + `onSelect` +
  ARIA/focus basics (App keeps the kind/lock logic). If it's not a full ARIA tablist, it's named a segmented control.
- **`<Chip active? disabled? icon?>`** — consolidates `chip`/`schip`/`tag-chip` ONLY after the alias audit confirms
  they're the same role (a genuinely different one stays its own component).
- **`<Input>` / `<Textarea>` / `<Badge tone>`** — thin token wrappers preserving the existing attributes/focus.

`cx(...parts: (string | false | null | undefined)[])` — a FROZEN class-composer (no object syntax, no dedupe); unit-
tested for falsey filtering + stable order. Variant→class is an explicit object per component, no clever composition.
The kit imports no vscode, no React; bundled into each webview (a post-impl size note records the delta).

### Parity is alias-audit + visual-equivalence, NOT byte-equivalent (folded from Codex)

Normalizing `ds-btn primary`→`ds-btn-primary` and `chip/schip/tag-chip`→one is a DELIBERATE change — so two gates:
- **Alias audit (before migrating a panel):** map each old class spelling → its computed CSS intent, and mark each
  `equivalent` (safe to normalize) or `intentional change` (the old spelling rendered differently — decide explicitly,
  don't silently flatten). A `schip`/`tag-chip` that's a genuinely different role does NOT collapse into `<Chip>`.
- **Visual-equivalence proof:** a before/after harness render of the migrated surface + a reviewer checklist focused
  on tabs/buttons/chips (alignment, size, spacing, disabled/active states). `/visual-qa` records the exact surface +
  pass criteria (it's advisory, not a pixel oracle) — the claim is "reviewed visual equivalence + intentional
  normalization", never "byte parity".

### Migration (incremental, proof-first — Lane A is THIS spec)

THIS spec ships the FOUNDATION + the first migrated panel; the rest are a tracked follow-up (honest scope):
1. **Lane A (this spec) — kit + Agent Studio** (the named pain): land the CSS alignment rules + the kit + the guard,
   migrate `agent-studio/App.tsx`'s tabs + buttons + chips, alias-audit + visual-equivalence proof, `/visual-qa
   agent-studio` confirmation.
2. **Follow-up lanes (a migration MANIFEST, not this spec):** the 8 remaining panels with their CURRENT banned-class
   counts (the work-list), so the thread isn't lost after one panel: pin-studio (25 btns), plugins (16), sidebar (13),
   activity (10), inspector (6), handoff (2), probes (0), pin-preview. Each later lane: alias-audit → migrate →
   visual-equivalence → extend the guard's migrated-view scope.

### Enforcement guard — the PRODUCT, not a nice-to-have (folded from Codex)

A component prevents drift ONLY for who uses it; the GUARD is what makes the kit non-bypassable, so it's a first-class
acceptance gate:
- A unit test (the spec-279/280 convention-guard pattern) scans MIGRATED views' `*.tsx` for banned class TOKENS
  (`ds-btn`, `ds-tab`, `chip`) in `class=`/`className=` string literals + simple `cx("…")` literals.
- Scope = a migrated-view manifest (grows as lanes land — never fails an un-migrated panel); allowlist `shared/ui/**`
  (which legitimately applies the classes) + test fixtures.
- A NEGATIVE FIXTURE proves it fails on a raw `class="ds-btn"` in Agent Studio.
- It catches the common drift path (literal class strings); it does NOT chase every inline-style bypass — documented:
  a new visual primitive MUST go through the kit.

## Acceptance criteria

- [x] **CSS alignment fix:** `design-system.css` carries the canonical button/tab/chip icon rules (inline-flex +
  `align-items:center`; `.ds-*  .codicon` fixed `font-size`/`line-height:1`/`flex:none`; `--ds-icon-gap` token) — the
  rendering source of truth.
- [x] **Kit (authoring API):** `src/webview/shared/ui/` exports `Icon`, `Button`, `IconButton`, `Tabs`, `Chip`,
  `Input`, `Textarea`, `Badge` — typed Preact applying the canonical classes; `cx()` is frozen + unit-tested.
- [x] **Agent Studio migrated (proof) with parity gates:** `agent-studio/App.tsx` tabs/buttons/chips compose the kit;
  no hand-rolled `ds-btn`/`ds-tab`/`chip` markup remains there; an ALIAS AUDIT classifies each old spelling
  (equivalent vs intentional) and a before/after visual-equivalence proof (+ `/visual-qa agent-studio`) confirms the
  tab/button consistency — claimed as reviewed visual equivalence + intentional normalization, NOT byte parity.
- [x] **Behavior/a11y preserved:** the agent-studio unit tests stay green; disabled/title/focus + Tabs ARIA-or-
  segmented semantics preserved; chip aliases classified before any consolidation.
- [x] **Enforcement guard (first-class):** a unit test scans MIGRATED views' `*.tsx` for banned class tokens
  (`ds-btn`/`ds-tab`/`chip`) in `class=`/`cx()` literals; `shared/ui/**` + fixtures allowlisted; a NEGATIVE fixture
  proves it fails on a raw `ds-btn` in Agent Studio.
- [x] **Migration manifest (scope honesty):** the remaining 8 panels + their current banned-class counts are recorded
  as the follow-up work-list; the status says "foundation + first migrated panel", not "inconsistency impossible".
- [x] **Bundle note:** the bundled-size delta for agent-studio + one other webview is recorded after impl.
- [x] **No regression:** full suite + typecheck + build + engine-boundary green.

## Open questions — RESOLVED (Codex dueto 2026-06-28, leans folded)

- **OQ1 — wrap vs own:** **WRAP, but CSS owns rendering truth.** Components are the only authoring API; the canonical
  alignment/spacing lives in `design-system.css` (`.ds-* .codicon` rules + `--ds-icon-gap`), never only in component
  markup. Consolidating `.ds-*` into the kit is a later cleanup, not v1.
- **OQ2 — `cx()`:** **own, frozen.** `cx(...parts: (string|false|null|undefined)[])` only — no object syntax/dedupe;
  unit-test falsey filtering + stable order; variant→class is an explicit per-component object.
- **OQ3 — scope:** **Lane A only, named honestly.** Ship kit + Agent Studio as the proof slice; the remaining 8 panels
  are a required migration-manifest follow-up (not "the inconsistency is gone").
- **OQ4 — guard:** **strict only inside migrated views** — a manifest-scoped string-literal scan, `shared/ui/**` +
  test allowlists, a required violation fixture. Never fail an un-migrated panel.
- **OQ5 — Tabs:** **presentation + `onSelect` + ARIA/focus basics.** The App keeps the kind/active/lock logic; the kit
  renders + is a real tablist or an honestly-named segmented control.

## Non-goals

- Tailwind / shadcn / Radix / any React dependency (the owner's explicit call — fights the Preact-only webviews).
- A re-platform of `design-system.css` to scoped/utility CSS (the components wrap it; consolidation is a later cleanup).
- Redesigning the button/tab LOOK (this standardizes the existing look; a deliberate visual redesign is separate).
- Migrating every panel in this spec (proof slice = Agent Studio; the rest are follow-up lanes).
- A theming/token overhaul (the `--ds-*`/`--vscode-*` tokens stay as-is).

# Tachyon webview style guide

**Single design system for every Tachyon webview** (sidebar, Control, Board, studios, embeds).

**Two editor apps (spec 410):** long-term only **`sidebar`** + **`cockpit`**. New full-page editor UI is a cockpit **section** (extend `WEBVIEW_SURFACES` / `CockpitSectionId`), not a new `src/webview/*/main.tsx` peer app. Multi-instance panels (task detail, handoff, probes) may stay thin hosts (`editorHome: "standalone-multi"`). See `docs/specs/410-cockpit-single-app/`.

This document is the **contract**. Values live in `src/webview/shared/design-system.css` (`--ds-*` over `--vscode-*`). Components live in `src/webview/shared/ui/` (legacy primitives + `kit/` + product patterns). Do not invent a second token set or a second button.

Related: specs **252** (tokens), **282** (component kit), **342** (vendored shadcn/kit wrappers). Plan: `docs/plans/unified-webview-design-system.md`. Review: `docs/reviews/styleguide-fable.md`.

---

## Stack (one stack)

```
VS Code theme (--vscode-*)
  → tokens (--ds-*)  [+ shadcn bridge in vscode-theme.css / tailwind-theme.css]
    → primitives     [shared/ui: Button, Badge, Input, …]
    → kit wrappers   [shared/ui/kit: KitSelect, KitDropdown, …]
    → product patterns [PageChrome, ListRow, EmptyState, …]
      → each webview surface
```

| Use | Do not |
|-----|--------|
| `--ds-*` tokens | Hardcoded hex/rgb for chrome |
| `Button` / `Badge` / `PageChrome` / `ListRow` | Raw `<button class="…">` for product actions |
| `shared/ui/kit` for Select/Dropdown/Popover | Import `shared/ui/vendor` from a surface |
| Codicons via `Icon` | Random emoji as structure (decorative ok sparingly) |

**Preact only.** Radix via preact/compat. Tooltip/Dialog remain gated (no KitTooltip/KitDialog until the compat gate passes) — use lightweight CSS/title fallbacks.

**Tailwind** is allowed on surfaces that already load a Tailwind sheet (Board, Plugins) **only** for layout utilities that map to the same tokens — not a second visual language.

---

## Tokens (roles)

| Role | Token (examples) | Use |
|------|------------------|-----|
| Foreground | `--ds-fg`, `--ds-muted` | Body / secondary |
| Border | `--ds-border` | Hairlines, cards |
| Surfaces | `--ds-card`, `--ds-input-bg`, editor bg | Panels |
| Focus | `--ds-focus` | Focus ring / active tab |
| Status | `--ds-ok`, `--ds-warn`, `--ds-err`, `--ds-info` | Badges |
| Radius | **`--ds-radius` only** (6px) | One radius; shadcn `--radius` must bridge to this |
| Type | `--ds-body`, `--tachyon-font-mono` | Default UI is mono-dense (sidebar/Control density) |
| Space | `--ds-1` … `--ds-6`, **page shell** `--ds-page-pad-x/y/bottom`, `--ds-page-chrome-*`, `--ds-border-width` | Gaps; **editor pages must use page shell tokens** — not ad-hoc `12px 16px` |
| Border thickness | **`--ds-border-width` (1px)** | Cards, chrome rules, hairlines — no `2px` chrome borders unless focus ring |

Disabled opacity: prefer `--ds-disabled-opacity` when present. Derived states may `calc()` off that base token; bare new numeric opacities (0.35/0.45/0.5) must not appear in surface CSS.

Page title size: **16px** via `.ds-page-chrome-title` — do not invent 20px panel titles.

---

## Components (reuse rule)

**If a control appears more than once, it must be a shared component** (or an existing primitive). Copy-paste markup across webviews is a defect.

### Required authoring API

| Need | Import |
|------|--------|
| Button | `Button` from `shared/ui` — variants: **`primary`** = the page’s single primary action; **`default`** otherwise; **`danger`** = destructive. At most one `primary` per tab/page body. **One box**: min-height 28px, pad `--ds-2/--ds-3`, mono `--ds-small`. Never restyle bare `button` / `.ds-btn` in surface CSS. |
| Icon button | `IconButton` |
| Badge / status | `Badge` (`tone`: default \| ok \| warn \| err \| info). **All status chips use `Badge`.** Do not introduce `ci-badge` / status-colored `ck-chip` modifiers for new UI; migrate existing when touching the surface. KPI count tiles (Overview numbers) are **not** status badges — they may stay metric chips until a MetricChip pattern exists. |
| Text / textarea / native select | `Input`, `Textarea`, `Select`, `FieldRow` |
| Tabs | `Tabs` |
| Chip | `Chip` (non-status labels only) |
| Page title + hint + actions | **`PageChrome`** — title=`--ds-title` (16) mono semibold; hint=`--ds-small` muted; **no title icon**. |
| Dense list (Control cards) | **`ListRow`** |
| Sidebar-density row (name + status dot + hover actions) | **`DenseRow`** (`.row` DOM; surface CSS) |
| Empty / loading | **`EmptyState`** |
| Tabular data | **`DataTable` interim** = promote/copy the Control `ck-table` pattern with `--ds-*` tokens until a shared `Table` lands in `patterns.tsx`. Do not invent a third table skin. |
| Labeled field / select menu | `kit/KitLabeledInput`, `KitSelect`, `KitDropdown`, … |


### Density chrome exception (sidebar / menus)
Icon-only **hit targets** (`.act`, `.more-item` menu rows) use **native `<button>` + `Icon`**, not `IconButton`/`Button`.  
Those kit components always add `.ds-btn` (padding, border, flex gap) and **break** 22×22 hits and menu layout (0.56.67 regression). Product primary/secondary actions still use `Button`.

### Product patterns (not one-off CSS)

- **PageChrome** — every full page or Control tab body that has a **title + optional hint + optional actions** row. Pure canvas (no title row) is the only exception. **Title has no codicon** — matches Fleet. The `icon` prop is deprecated/ignored.
- **ListRow** — idle / hover / selected / current; no hard-coded row hover colors in surface CSS.
- **EmptyState** — icon + message (+ optional action).

### Editor page shell (Control + panels — not sidebar)

Reference: **Fleet** tab.

| Element | Contract |
|---------|----------|
| Outer pad | `var(--ds-page-pad-y) var(--ds-page-pad-x) var(--ds-page-pad-bottom)` (or class `.ds-page`) |
| Header | `PageChrome`: title 16px + hint 11px muted + actions |
| Header gap/margin | `--ds-page-chrome-gap`, `--ds-page-chrome-margin-bottom` |
| Border width | `--ds-border-width` only |
| Title icon | **Forbidden** |

Surface CSS must not invent alternate header padding (`20px`, `8px 12px`, …) for the page chrome.

**Fleet spacing parity:** editor pages share one outer pad (`--ds-page-pad-*`). Do not add a second horizontal pad on `.ds-wrap` or embed hosts. Board header is **not** a separate widget bar (no `editorWidget` background strip / full-width hairline under tools) — only `PageChrome` + body.

### Visual gate (before package / done on UI)

Does **not** block improvements — blocks ship without looking.

1. Sidebar: `.act` + `⋯` menu codicons OK (native button+Icon).
2. Touched editor page: Fleet-like header (no title icon), pad/border match neighbors.
3. FAIL → fix same trail; do not pack.

Agents may **extend** this checklist when adding surfaces; they must not **delete** the proof step.

---

## Layout & density

- **Default density:** sidebar-like (11–13px labels, tight gaps). Control matches sidebar mono stack.
- **Embedded surfaces inside Control:** full-bleed host; **no** standalone `max-width` column; no second global `html/body` layout. Shell reset lives in `cockpit.css` (linked last).
- **Do not** center product UI in a 980px column inside Control.
- Prefer flex column + `min-height: 0` for scroll regions.

---

## UX rules (honest UI)

1. **Do not overclaim.** Process language while pending; result verbs (`verified`, `deleted`, `failed`) only with real state.
2. **Match feedback to duration.** Instant local vs Bridge/tmux latency — defer spinners ~200ms for local.
3. **Cancel ≠ destructive.** Back-out paths are not Delete.
4. **Sibling consistency.** Same action same control across tabs.
5. **One toast/error pattern** per surface family; prefer host toast in Control.

---

## Control (special)

Control is a **tab shell**, not six independent apps.

- Shared tab strip: `ck-tabs` only.
- **Tab bodies with a title / hint / actions row use `PageChrome`** (including Overview shell actions). Native `ck-*` markup without PageChrome is only for pure canvas/table bodies with **no** title row.
- Embeds (Board, Approvals, Validations, Runtime, tmux, Plugins) must still use shared buttons/badges/chrome for product identity; standalone CSS may load but must not redefine those.
- Per-surface migration status: see plan `docs/plans/unified-webview-design-system.md` (do not assume “priority pilot” means done).

### Pilot status (honest)

| Surface | Chrome / buttons | Notes |
|---------|------------------|--------|
| Approvals | done | foundation |
| Validations | done | Phase B |
| Control module lists (Fleet / Worktrees / Deliveries) | done | ListRow + Badge |
| Overview | done | PageChrome |
| Runtime Ops | done | PageChrome |
| Board | head done (PageChrome + primary Task) | kanban body out of scope |
| tmux / Inspector | done | PageChrome + Tabs + density |
| Activity | done | PageChrome + kit buttons |
| Plugins | done | PageChrome + Badge |
| Task detail | done | PageChrome + Badge |
| control-inspector | done | PageChrome + Badge |
| pipeline-studio | done | Button/IconButton |
| `MIGRATED_VIEWS` guard | includes Control family | cockpit/approval/validations/runtime-ops |

---

## Migration

1. **New UI** → shared primitives / kit / patterns only.
2. **Touch a surface** → migrate the controls you touch (no drive-by whole-app rewrites).
3. **Control family** is the highest inconsistency pain — migrate chrome/buttons/rows when working here; do not claim “pilot done” without adoption.
4. **Board** → align head/actions first; kanban layout can stay; tokens must match.
5. **Guards:** `test/unit/webviewComponentKit.test.ts` enforces `MIGRATED_VIEWS` including Control family (`cockpit`, `approval`, `validations`, `runtime-ops`) plus earlier surfaces. Hand-rolled `ds-btn` / `ds-tab` / bare `chip` class tokens are banned in those dirs — use kit components. KPI tiles use `ck-metric` (not `chip`).

---

## Review checklist (UI PR)

- [ ] No new hex for chrome; tokens only (`--ds-*`)
- [ ] Buttons are `Button` / `IconButton` with correct variant hierarchy
- [ ] Status chips are `Badge` tones
- [ ] Repeated UI extracted or already shared (`ListRow` / `PageChrome` / `EmptyState`)
- [ ] Control embed: no skinny centered column
- [ ] Control tab with a title row → uses `PageChrome` (not hand-rolled `<h1>`)
- [ ] Copy does not overclaim
- [ ] Visual check: Control tab + one other surface if chrome changed

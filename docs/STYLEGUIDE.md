# Tachyon webview style guide

**Single design system for every Tachyon webview** (sidebar, Control, Board, studios, embeds).

This document is the **contract**. Values live in `src/webview/shared/design-system.css` (`--ds-*` over `--vscode-*`). Components live in `src/webview/shared/ui/` (legacy primitives + `kit/`). Do not invent a second token set or a second button.

Related: specs **252** (tokens), **282** (component kit), **342** (vendored shadcn/kit wrappers). Plan: `docs/plans/unified-webview-design-system.md`.

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
| Status | `--ds-ok`, `--ds-warn`, `--ds-err`, `--ds-info` | Badges, chips |
| Radius | **`--ds-radius` only** (6px) | One radius; shadcn `--radius` must bridge to this |
| Type | `--ds-body`, `--tachyon-font-mono` | Default UI is mono-dense (sidebar/Control density) |
| Space | `--ds-1` … `--ds-4` | Gaps/padding scale |

Disabled opacity: prefer `--ds-disabled-opacity` when present; do not invent per-surface 0.35/0.45/0.5.

---

## Components (reuse rule)

**If a control appears more than once, it must be a shared component** (or an existing primitive). Copy-paste markup across webviews is a defect.

### Required authoring API

| Need | Import |
|------|--------|
| Button | `Button` from `shared/ui` |
| Icon button | `IconButton` |
| Badge / status | `Badge` (`tone`: default \| ok \| warn \| err \| info) |
| Text / textarea / native select | `Input`, `Textarea`, `Select`, `FieldRow` |
| Tabs | `Tabs` |
| Chip | `Chip` |
| Page title + hint + actions | **`PageChrome`** |
| Dense list row (fleet, tasks meta, worktrees…) | **`ListRow`** |
| Empty / loading | **`EmptyState`** |
| Labeled field / select menu | `kit/KitLabeledInput`, `KitSelect`, `KitDropdown`, … |

### Product patterns (not one-off CSS)

- **PageChrome** — every full page or Control tab body that is not a pure canvas (Board may keep dense tools *under* chrome).
- **ListRow** — idle / hover / selected / current; no hard-coded row hover colors in surface CSS.
- **EmptyState** — icon + message (+ optional action).

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
- Tab bodies: either native `ck-*` **or** embed wrapped so titles/actions use **PageChrome** / shared buttons.
- Standalone panel CSS may still load for embeds; it must not redefine product identity (buttons, badges, page heads).

---

## Migration

1. **New UI** → shared primitives / kit / patterns only.
2. **Touch a surface** → migrate the controls you touch (no drive-by whole-app rewrites).
3. **Control + Approvals/Validations** → priority pilots for chrome + buttons (highest inconsistency pain).
4. **Board** → align head/actions first; kanban layout can stay; tokens must match.
5. Guards: kit/convention tests ban new hand-rolled `.ds-btn` markup and hard-coded row selection colors where enforced.

---

## Review checklist (UI PR)

- [ ] No new hex for chrome; tokens only  
- [ ] Buttons are `Button` / `IconButton`  
- [ ] Repeated UI extracted or already shared  
- [ ] Control embed: no skinny centered column  
- [ ] Status via `Badge` tones  
- [ ] Copy does not overclaim  
- [ ] Visual check: Control tab + one other surface if chrome changed  

# `shared/ui/` — the Tachyon component library

_Contract: `docs/STYLEGUIDE.md` (tokens, rules, review rubric). Plan: `docs/plans/unified-webview-design-system.md`._
_Specs: 252 (tokens), 282 (component kit), 342 (vendored shadcn/kit wrappers), 410 (two apps: sidebar + cockpit)._

**This directory IS the component library.** Every reusable control in any webview surface comes from
here. The library is a living artifact — components get added, replaced, and retired over its life —
but there is always exactly ONE library, and surfaces never fork their own copies of it. The
evolution rule: change the library, migrate the call sites, retire the old entry — never ship a
parallel implementation "for now".

Three layers live side by side here on purpose (spec 342 F11). **They are namespaced so they can
never be import-confused:**

| Layer | Path | What it is | Import from |
| --- | --- | --- | --- |
| **Primitives** | `shared/ui/*.tsx` | Hand-rolled Preact over `design-system.css` `.ds-*` | `../shared/ui` |
| **Product patterns** | `shared/ui/patterns.tsx` | Repeated chrome/rows/empty states | `../shared/ui` |
| **Kit wrappers** | `shared/ui/kit/*.tsx` | House wrappers over vendored shadcn/Radix | `../shared/ui/kit` |
| **Vendor source** | `shared/ui/vendor/*.tsx` | Vendored shadcn/Radix internals | **never** from surfaces |

## Catalog

### Primitives (`../shared/ui`)

| Component | Essential API | Use for | Don't |
| --- | --- | --- | --- |
| `Button` | `variant: default\|primary\|danger`, `icon?` (leading codicon), `class?` | Every product action | Raw `<button>`; a second button class; icon via child when the `icon` prop fits |
| `IconButton` | `name` (codicon), `title` (required — it's the a11y label) | Icon-only actions (close, clear, copy) | `Button` with only an icon child |
| `Icon` | `name` (codicon) | All iconography | Emoji as structure; inline SVG for things codicons cover |
| `Tabs` | `items: TabItem[]` | In-page tab strips | Hand-rolled `.tab` markup |
| `Chip` | see `ChipProps` | Small removable/selectable tokens | Reusing `Badge` for interactive tokens |
| `Badge` | `tone: default\|ok\|warn\|err\|info` | Status labels | New per-surface badge CSS; hardcoded status colors |
| `Input` / `Textarea` / `Select` | forwardRef'd, token-styled | Legacy form controls (existing surfaces) | New UI — new forms use `kit/` (`KitSelect`, `KitLabeledInput`) |
| `FieldRow` | label + control layout | Legacy field rows | New UI — use `KitFieldRow` |
| `cx` | class combiner | Conditional classes | String concat with manual spaces |

### Product patterns (`../shared/ui`)

| Component | Essential API | Use for |
| --- | --- | --- |
| `PageChrome` | `title`, `hint?`, `actions?` | Every full-page/section header (16px title — the only page-title size) |
| `ListRow` | `state: idle\|hover\|selected\|current` | Control-style card/list rows |
| `DenseRow` | `dot?`, `name`, `sub?`, `meta?`, `actions?` | Sidebar-density rows |
| `EmptyState` | `kind: empty\|loading\|error`, `message`, `action?` | Empty/loading/error bodies — never a bare "No items" `<div>` |

### Kit (`../shared/ui/kit`) — the authoring API for NEW UI

| Component | Essential API | Use for |
| --- | --- | --- |
| `KitSelect` | `options: KitSelectOption[]` | All new selects (legacy `Select` only in unmigrated surfaces) |
| `KitFieldRow` / `KitLabeledInput` | label/control composition | New form rows |
| `KitDropdown{,Trigger,Content,Item,Separator}` | Radix composition | Menus / overflow actions |
| `KitPopover{,Trigger,Content,Anchor,Header,Title,Description}` | Radix composition | Anchored popovers |
| `KitFilePicker` | `KitFilePickerProps` | File selection |
| `KIT_FLAGS` | feature flags | Gating kit rollouts |

**Preact only.** Radix runs via preact/compat. Radix deps are exact-pinned (`vendor/VENDORED.md`).

## Known gaps — the promotion queue

A gap means surfaces are hand-rolling the pattern today. Promoting a gap = build the shared
component + migrate every hand-rolled call site in the same trail. Tracked on the board:

| Gap | Evidence (audit 2026-07-20) | Task |
| --- | --- | --- |
| `KitTooltip` / `KitDialog` | 4 surfaces hand-roll overlay/modal CSS (rich-doc, sidebar, mission-control, activity); tooltip CSS in mission-control | t-c7e518 (gated on the preact/compat gate — until then: `title=` fallback, no new modal CSS) |
| `KitRow` | Control/list rows still partially per-surface | t-eaa94d |
| `SearchBox` | activity + mission-control each own a search-input cluster (icon + input + clear) | t-b0a229 batch |
| `Spinner` / loading affordance | 4 surfaces own spin keyframes (handoff, task-detail, mission-control, activity) | t-b0a229 batch |
| `StatusDot` | `.dot` styled per surface (sidebar, mission-control, attention cards) | t-b0a229 batch |
| Card/chip CSS consolidation | task-studio, mission-control, plugins each define `.card`/`.chip` | t-b0a229 batch |
| Raw `<button>` residue | 37 raw `<button>`s outside shared/ui (worst: rich-doc/toolbar 15, sidebar 10) | migrate on touch; new code: zero |
| Hardcoded hex in surface CSS | 68 occurrences outside shared/vendor | migrate on touch; new code: zero |

## Migration status (SDD 410 Phase B updates this per surface)

| Surface | Uses | Notes |
| --- | --- | --- |
| Plugins | KitSelect, KitDropdown; Button | Pilot A |
| Task Studio | KitFieldRow, KitLabeledInput, KitSelect | Pilot B |
| Control module tabs | PageChrome via ModuleChrome | foundation |
| Approvals / Validations / Runtime | PageChrome, Button, EmptyState | Phase B |
| Sidebar | Badge, Button, EmptyState, DenseRow | Phase C.1–C.2 |
| Other panels | legacy / surface CSS | migrate on touch |

## Adoption rules

- **New UI** = primitives + patterns + kit. Never hand-rolled product buttons/rows/selects.
- **Appears twice → shared component** (STYLEGUIDE). Copy-pasted markup across webviews is a defect.
- **Tooltip/Dialog** stay excluded from kit until the preact/compat gate passes (342) — use
  lightweight CSS/`title` fallbacks; do not add new per-surface modal CSS.
- Every SDD 410 cockpit-section migration adopts the library for that surface in the same PR —
  app consolidation and visual consolidation ride together.

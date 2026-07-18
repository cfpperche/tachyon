# `shared/ui/` — the webview component kit

_Contract: `docs/STYLEGUIDE.md`. Plan: `docs/plans/unified-webview-design-system.md`._  
_spec 342 T8 + product patterns (PageChrome / ListRow / EmptyState)._

Three layers live side by side here on purpose (spec 342 F11). **They are namespaced so they can never be import-confused:**

| Layer | Path | What it is | Import from |
| --- | --- | --- | --- |
| **Legacy `.ds-*` primitives** | `shared/ui/*.tsx` (`Button`, `Icon`, `IconButton`, `Tabs`, `Chip`, Field controls, `Badge`) | Hand-rolled Preact over `design-system.css` `.ds-*`. | `../shared/ui` |
| **Product patterns** | `shared/ui/patterns.tsx` (`PageChrome`, `ListRow`, `EmptyState`) | Repeated chrome/rows/empty — **reuse when UI appears more than once**. | `../shared/ui` |
| **Vendor source** | `shared/ui/vendor/*.tsx` | Vendored shadcn/Radix (internal). | never from surfaces |
| **Kit wrappers** | `shared/ui/kit/*.tsx` | `KitSelect`, `KitFieldRow`, `KitDropdown*`, … | `../shared/ui/kit` |

## Migration status

| Surface | Uses | Notes |
| --- | --- | --- |
| Plugins | KitSelect, KitDropdown; Button | Pilot A |
| Task Studio | KitFieldRow, KitLabeledInput, KitSelect | Pilot B |
| Control module tabs | PageChrome via ModuleChrome | foundation |
| Approvals | PageChrome, Button, EmptyState, IconButton | foundation pilot |
| Other panels | legacy / surface CSS | migrate on touch |

## Adoption rule

- **New UI** = shared primitives + patterns + kit (not hand-rolled product buttons/rows).
- **Appears twice → shared component** (STYLEGUIDE).
- **Tooltip/Dialog** excluded from kit until preact/compat gate (342).
- Radix deps exact-pinned (`VENDORED.md`).

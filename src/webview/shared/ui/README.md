# `shared/ui/` — the webview component kit

_spec 342, T8. Written for the ad-hoc implementer agents who pick up the next surface — read this before
importing anything from `shared/ui/`._

Three layers live side by side here on purpose (spec 342 F11: a naming trap — two similarly-named
`Select`/`FieldRow` implementations existing in the same directory tree was flagged as a real risk during
design review). **They are namespaced so they can never be import-confused:**

| Layer | Path | What it is | Import from |
| --- | --- | --- | --- |
| **Legacy `.ds-*` primitives** | `shared/ui/*.tsx` (`Button`, `Icon`, `IconButton`, `Tabs`, `Chip`, `Field.tsx`'s `Input`/`Textarea`/`Select`/`FieldRow`/`Badge`) | Hand-rolled Preact components styled by `design-system.css`'s `.ds-*` classes. Pre-date this spec; still the ONLY implementation for controls Kit doesn't cover yet (checkboxes, radios, badges, tabs, chips). | `../shared/ui` (barrel: `index.ts`) |
| **Vendor source** | `shared/ui/vendor/*.tsx` | Unmodified-behavior shadcn/ui + Radix component source (Tooltip/DropdownMenu/Select/Popover/Dialog), adapted ONLY at the import boundary (registry `radix-ui` meta-package → this project's exact-pinned `@radix-ui/react-*`; `@/lib/utils` → `./lib/utils`; `lucide-react` icons → the project's own `Icon`). Never import these directly from a surface — go through `kit/`. | Nowhere directly (internal to `kit/`) |
| **Kit wrappers** | `shared/ui/kit/*.tsx` | The house authoring API: `KitSelect`, `KitFieldRow`, `KitLabeledInput`, `KitDropdown*`, `KitPopover*`. Compose vendor source (or legacy primitives, for `KitFieldRow`) behind a stable, simplified prop contract. **New UI reaches for `kit/`.** | `../shared/ui/kit` (barrel: `index.ts`) |

## Migration status (which surfaces use what)

| Surface | Uses | Notes |
| --- | --- | --- |
| Plugins panel (`src/webview/plugins/`) | `KitSelect` (installed-list sort), `KitDropdown` (per-card overflow menu) | Pilot A (T5). Primary card actions (Update/Reinstall/Remove) stay `Button`. |
| Task Studio (`src/webview/task-studio/`) | `KitFieldRow`, `KitLabeledInput` (Kind, Assignee), `KitSelect` (Priority) | Pilot B (T7). `ts-chip-fields` (Deps/Artifacts) is untouched — a bespoke chip-input pattern, not Select/Input. |
| Every other panel (sidebar, activity, handoff, probes, inspector, agent-studio, pin-preview, pin-studio, mission-control, task-detail) | legacy `.ds-*` only | Byte-untouched by this spec (spec.md's "no regression outside the pilots" acceptance). |

## The adoption rule

- **New UI = `kit/`.** If you're building a Select, a labeled input, a dropdown menu, or a popover for a new
  surface (or a surface not yet migrated), import from `shared/ui/kit`, not `shared/ui`'s legacy primitives
  and not `shared/ui/vendor` directly.
- **Legacy migrates only with a reason.** Don't rewrite a working `.ds-*` control to Kit just to "modernize"
  it — migrate a surface when its OWN work (a redesign, a new field, a dogfood-driven fix) already touches
  that control, the same way Pilot A/B did.
- **Not every Kit wrapper has a legacy fallback.** `KitSelect` is the one wrapper with a REAL dual
  radix/legacy implementation (a build-time flag, `shared/ui/kit/flags.ts` + `TACHYON_KIT_SELECT` env var —
  see `esbuild.mjs`'s `kitDefines`). `KitFieldRow` is a thin re-export (no Radix dependency to gate).
  `KitLabeledInput` composes a plain `<input class="ds-input">` (new a11y wiring, no second implementation
  needed). `KitDropdown`/`KitPopover` have no pre-existing legacy equivalent to fall back to — same posture
  as `Dialog`'s exclusion, just on the passing side of the T3 compat gate.
- **`Tooltip` and `Dialog` are EXCLUDED** — they failed the T3 compat gate under preact/compat (see
  `notes.md`'s gate-results table for the exact repro). No `KitTooltip`/`KitDialog` exists. A surface needing
  either keeps its current ad-hoc approach until a future spec re-gates them.
- **Any Kit component's Radix runtime deps are EXACT-pinned** (see `VENDORED.md`). Bumping a Radix package
  version reruns the T3 compat gate and updates its results table — a version bump is not a drive-by
  `package.json` edit.

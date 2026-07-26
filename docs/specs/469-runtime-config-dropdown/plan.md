# 469 — runtime-config-dropdown — plan

_Drafted from `spec.md` on 2026-07-26. The approach, not the steps (those go in `tasks.md`)._

## Approach

Compose the existing `KitDropdown` primitives directly in `RuntimeConfigInventory`. Its trigger is a
Runtime Config-styled button containing `RuntimeLogo`, the localized label, and a chevron. Each menu
item repeats the logo/label pair and selects the runtime through the existing state transition,
including resetting `documentId` to the first document. Add scoped CSS for trigger, portal content,
items, logo sizing, focus and selected state. Pin the structure with a focused source-contract test,
then inspect the rendered Control surface.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Reuse `KitDropdown`** — chosen because it already supplies focus, keyboard and menu semantics;
  rejected a native `<select>` because option rows cannot reliably render runtime icons.
- **Reuse `RuntimeLogo`** — chosen because Agent Studio already owns the canonical Claude/Codex brand
  assets; rejected duplicate SVGs because they would drift.
- **Keep scope segmented** — the request concerns runtime identity only and scope remains a small,
  meaningful two/three-option switch.

## Files touched

- `src/webview/cockpit/App.tsx` — dropdown composition and existing selection transition.
- `src/webview/cockpit/cockpit.css` — Runtime Config-specific dropdown presentation.
- `test/unit/runtimeConfigDropdown.test.ts` — regression contract for dropdown, icon reuse and scope boundary.
- `docs/specs/469-runtime-config-dropdown/*` — intent, plan, execution and evidence.

## Risks & unknowns

- Portal content could inherit insufficient styling on the Cockpit route; verify the real rendered menu.
- Runtime logos use Agent Studio class names; Runtime Config must own explicit local sizing.
- Runtime refresh can remove the selected runtime; preserve the existing fallback behavior.

## Visual impact

The runtime field becomes one compact trigger rather than two adjacent buttons. Check icon size,
vertical alignment, menu width, selected mark, focus treatment and toolbar wrapping at the supplied
Control width. Capture a rendered screenshot and verdict.

## Sources consulted

- `src/webview/cockpit/App.tsx` (`RuntimeConfigInventory`)
- `src/webview/cockpit/cockpit.css` (`.rcp-*`)
- `src/webview/shared/ui/kit/KitDropdown.tsx`
- `src/webview/agent-studio-shell/runtimeLogos.tsx`
- User screenshot `Screenshot 2026-07-26 124125.png`

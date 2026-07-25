# 453 — agent-studio-static-sections — plan

_Drafted from `spec.md` on 2026-07-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

Replace each configuration `<details>` wrapper with a semantic `<section>` using one shared static-card
class. Keep every existing control, handler, conditional, id, and hint in place. Add a short help line
where a block currently has no explanatory copy, remove disclosure-specific CSS, and add a source-level
regression test covering all three blocks. Validate the real New/Edit previews at desktop and narrow
widths.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- Scope the removal to the three configuration disclosures named by the task; Agent Evolution's
  per-file diff disclosure remains because expanding every proposed file would be a separate behavior
  change.
- Reuse the existing card vocabulary and `ash-label` typography, avoiding a new interactive component.
- Preserve all field controls verbatim so serialization and dirty-state behavior cannot drift.

## Files touched

- `src/webview/agent-studio-shell/App.tsx`
- `src/webview/agent-studio-shell/agent-studio-shell.css`
- `test/unit/studioWorktreeFooterLayout.test.ts`
- `docs/specs/453-agent-studio-static-sections/*`

## Risks & unknowns

- Always-expanded harness content makes the form taller; spacing must keep the hierarchy scannable.
- Narrow screens already stress dense Studio forms, so static sections must stay at `min-width: 0`.

## Visual impact

Three previously collapsible regions become bordered, always-expanded cards in the normal document flow.

## Sources consulted

- `src/webview/agent-studio-shell/App.tsx`
- `src/webview/agent-studio-shell/agent-studio-shell.css`
- `test/unit/studioWorktreeFooterLayout.test.ts`

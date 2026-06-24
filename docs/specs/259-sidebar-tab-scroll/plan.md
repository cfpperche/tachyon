# Spec 259 — Sidebar tab scroll — plan

## Approach

Make the webview root a fixed-height flex column. The persistent shell elements (search, icon tabs, optional handoff bar, section header, Bridge footer) remain normal flex children, while the active `.panel` becomes the single flexible child with `min-height: 0` and `overflow-y: auto`.

This removes the old fixed-footer overlay workaround and lets `scrollIntoView()` keep working, because the nearest scrollable ancestor becomes the panel itself.

## Files to touch

**Create:**
- `docs/specs/259-sidebar-tab-scroll/{spec.md,plan.md,tasks.md,notes.md}` — intent, approach, checklist, and implementation notes.

**Modify:**
- `src/webview/SidebarPrototype.ts` — sidebar shell CSS: full-height root, body overflow hidden, panel scroll, non-fixed footer.
- `src/webview/sidebar/App.tsx` — remove the body padding workaround for a fixed footer.

**Delete:**
- None.

## Alternatives considered

### Keep the footer fixed and add body padding

Rejected because it still leaves the body as the scroll container; the screenshots show the global sidebar scrollbar moving through the shell. It also needs JavaScript to reserve footer height.

### Make only the footer sticky

Rejected because the pin asks for header and footer to stay static. Sticky footer alone would leave search/tabs/section header scrolling away.

## Risks and unknowns

- Very short sidebars can expose flex min-height bugs unless `.panel` and `#root` both use `min-height: 0`.
- Cmd/Ctrl+K reveal must still scroll the active row; this relies on browser `scrollIntoView()` choosing the new panel scroll container.

## Research / citations

- Pin text and screenshots from `/home/goat/Agent0/.tachyon/pins/p-eca2d9.json`.
- Current layout CSS in `src/webview/SidebarPrototype.ts`.
- Current tab selection and row reveal logic in `src/webview/sidebar/App.tsx`.

# Spec 261 — Sidebar pin preview — plan

## Design

- Add a shared `PinPreviewVM` to `src/sidebar/types.ts`.
- Add a `pin:preview` section action in `SidebarPrototypeProvider`.
- Host reads `ws.pinStore.readDetail(id)`, creates a readonly VS Code editor webview panel, resolves local attachment webview URIs for that panel, extracts a plaintext body from the Tiptap JSON, and renders the preview HTML.
- The sidebar app remains the trigger only; preview content does not render inside the sidebar and does not write back to the host.
- Add a Preview inline action adjacent to Copy on every pin row.

## Validation

- Unit test host preview routing/editor webview creation.
- Unit test pure doc text extraction where practical.
- Existing sidebar projection/copy tests remain green.
- `npm run typecheck`
- Targeted unit tests for sidebar/pins.
- `npm run build`
- `node scripts/screenshots/ds/render.mjs sidebar`
- `git diff --check`

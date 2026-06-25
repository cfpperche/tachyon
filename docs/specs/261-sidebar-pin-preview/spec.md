# Spec 261 — Sidebar pin preview

**Status:** shipped. · **Follows:** spec 255 Pin Studio, spec 256 sketches, spec 258 sidebar pin copy, spec 260 pin tags. · **Surface:** sidebar Pins tab, pin detail read path. · **UI impact:** ui.

## Intent

The Pins tab already has inline row actions for copying, editing, deleting, and completing pins. Rich pins now carry text bodies, tags, images, and sketches, but the sidebar only exposes the summary row unless the user opens Pin Studio. Add an inline Preview button next to Copy so a user can inspect a pin read-only in an editor webview panel without entering Pin Studio.

Source pin:

- `p-a0134d` — "pins botao inline pin preview"
- Body: "botao inline pin ao lado do copiar que abre em modo readonly um modal para visualizar o preview do pin"
- Maintainer correction on 2026-06-25: use an editor-panel webview instead of an in-sidebar modal.

## Acceptance

- [x] **Scenario: Preview a text-only pin**
  - **Given** a pin row is visible in the Pins tab
  - **When** the user clicks the inline Preview action beside Copy
  - **Then** Tachyon opens a read-only editor webview panel showing the pin title and body without toggling, editing, or opening Pin Studio.

- [x] **Scenario: Preview a rich pin**
  - **Given** a pin has a rich detail document, tags, and visual attachments
  - **When** the user previews it from the sidebar
  - **Then** the editor webview panel shows title, author/done/tags metadata, a readable body preview, and attachment thumbnails or unavailable states for local visual blobs.

- [x] **Scenario: Close preview safely**
  - **Given** the preview webview panel is open
  - **When** the user closes the editor tab
  - **Then** the panel closes without mutating pin state.

- [x] **Scenario: Preview routing respects multi-root**
  - **Given** multiple Tachyon workspaces are visible
  - **When** the user previews a pin in one workspace
  - **Then** the host reads the pin from that row's workspace hash, not the first workspace.

- [x] Existing inline Copy, Edit, Delete, Done toggle, tags filtering/search, tab scrolling, Pin Studio editing, Bridge tools, and project handoff behavior remain unchanged.

## Non-goals

- No editable preview mode.
- No in-sidebar preview modal.
- No editable VS Code document.
- No new MCP/Bridge tools.
- No persistence/schema changes.
- No image annotation or sketch editing from the preview panel.
- No full Tiptap renderer; v1 renders a readable readonly preview.

## Open Questions

- None. Maintainer direction supersedes the source pin's modal wording: the preview opens in an editor webview panel.

## Context / References

- `src/webview/sidebar/App.tsx` — existing Pins row actions and menu patterns.
- `src/webview/SidebarPrototype.ts` — host routing for row actions.
- `src/pins/PinStore.ts` — `readDetail()` detail/attachment read path.
- `src/pins/PinAttachmentStore.ts` — local visual blob resolution.

## Closure

**Closure:** shipped on 2026-06-25. Validated with `npm run typecheck`, `npm run build`, `npm test`, `node scripts/screenshots/ds/render.mjs sidebar`, and `git diff --check`. Residual scope: no full rich-text renderer; the editor webview panel renders a readable plaintext preview plus visual thumbnails/list items.

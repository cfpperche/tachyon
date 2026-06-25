# Spec 261 — Sidebar pin preview — notes

## 2026-06-25 — Research

Source pin detail read from `/home/goat/Agent0/.tachyon/pins/p-a0134d.json`:

> botao inline pin ao lado do copiar que abre em modo readonly um modal para visualizar o preview do pin

Existing implementation:

- The sidebar Pins row already has inline `copy` plus overflow `edit/delete` actions.
- Host row actions flow through `SidebarPrototypeProvider.runSection()`.
- `PinStore.readDetail()` already returns summary, doc, and resolved attachment records.
- The sidebar webview currently receives only fleet snapshots, so preview needs a host-posted message.

Decision:

- Build a readonly preview entry point from the sidebar. The source pin asked for a modal, but maintainer direction later changed the target to an editor webview panel.
- Keep it readonly and summary/detail-only; no persistence changes.
- Render rich docs as readable plaintext blocks in v1, plus attachment thumbnails/list items.

## 2026-06-25 — Maintainer correction

Updated the implementation from an in-sidebar modal to a VS Code editor webview panel:

- The inline sidebar eye button still dispatches `pin:preview`.
- The extension host now opens a readonly `tachyonPinPreview` webview panel with scripts disabled.
- Attachment local-resource roots are scoped to the selected workspace's pin blob directory.
- The sidebar no longer receives or renders `pinPreview` messages.

## 2026-06-25 — Closeout

Implemented:

- Shared `PinPreviewVM`/attachment view-model types.
- Host `pin:preview` section action with multi-root routing through the row `hash`.
- Readonly editor webview panel opened from an inline `eye` action beside Copy.
- Pin detail body extraction from Tiptap JSON and local visual attachment preview URI resolution.
- pt-BR l10n entry for preview failure notification.

Validated:

- `npm run typecheck`
- `npm run build`
- `npm test` — 95 files passed; 1403 tests passed; 3 skipped.
- `node scripts/screenshots/ds/render.mjs sidebar` — `sidebar-dark.png` and `sidebar-light.png` rendered.
- `git diff --check`

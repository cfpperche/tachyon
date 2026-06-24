# Spec 255 — Pin Studio rich pins — tasks

**Status:** implemented and locally verified in isolated worktree.

## Pre-plan

- [x] Resolve OQ1-OQ5 in `spec.md`.
- [x] Fold Claude review feedback or explicitly reject it in `notes.md`.
- [x] Draft `plan.md` with file-by-file implementation order.

## Implementation

- [x] 1. Add the v1 Tiptap OSS/framework-neutral dependencies to `package.json` and `package-lock.json`; confirm no React wrapper, Pro UI, DragHandle, or Excalidraw dependency is introduced.
- [x] 2. Extend `Pin` summary typing with optional `updatedAt`, `detail`, and `attachmentCount`; keep `PinStore.list/create/setDone/update/remove` backward-compatible for legacy `pins.json`.
- [x] 3. Add rich detail types and `PinStore` detail APIs for text-only fallback, rich read/save, atomic detail publication, updated summary metadata, unknown-id errors, and rich pin deletion.
- [x] 4. Add `PinAttachmentStore` with allowed MIME checks, 10 MB hard limit, 50 MB total-size warning probe, content-addressed temp+rename writes, dedup, workspace-relative paths, and containment tests.
- [x] 5. Update `.tachyon` gitignore/init logic so `.tachyon/pins/` is machine-local by default while `.tachyon/pins.json` remains shareable.
- [x] 6. Register Bridge `get_pin`; return summary plus Tiptap JSON and attachment metadata/relative paths/availability for rich pins, summary-only shape for legacy pins, and no binary/base64 payloads.
- [x] 7. Update Bridge/auth tool-list tests and pin MCP tests for the new tool count/name and `get_pin` rich/legacy/missing-id behavior.
- [x] 8. Add `PinStudioPanel` host code with CSP, shared `design-system.css`, blob `localResourceRoots`, `asWebviewUri` attachment resolution, import-file handling, save/cancel handling, and one-panel-per-workspace+pin reuse.
- [x] 9. Replace human Add/Edit pin command routing with Pin Studio while preserving programmatic preset-text `tachyon.addPin("text")` behavior and sidebar refresh after save/delete.
- [x] 10. Add the `src/webview/pin-studio` Preact/Tiptap bundle: title field, editor lifecycle, placeholder/slash command menu, toolbar, task/list/link/code formatting, paste/drop image handling, import affordance, Save/Cancel/error states.
- [x] 11. Add document normalization so persisted image nodes use canonical attachment references, not webview URIs; load-time render models rewrite previews through host-provided webview URIs.
- [x] 12. Extend sidebar `PinVM`/`FleetVM` and UI so rich pins show only summary fields plus attachment indicator/count; assert no document or image bytes enter the sidebar VM.
- [x] 13. Add unit tests for storage compatibility, rich detail save/read/delete, blob dedup and shared-blob delete safety, gitignore behavior, sidebar summary shape, and Pin Studio browser message flows.
- [x] 14. Add extension-host or mock-backed coverage that sidebar `+`/Edit and command-palette Add Pin route to Pin Studio, and repeated Edit for the same pin reveals the existing panel.
- [x] 15. Re-scan the implementation for spec-253 regressions: no `.tachyon/notes.md`, `get_notes`, `set_notes`, `tachyon.openNotes`, or free-form notes surface is reintroduced.

## Verification

- [x] `npx tsc --noEmit`
- [x] `npx tsc -p tsconfig.webview.json --noEmit`
- [x] `bash scripts/check-engine-boundary.sh`
- [x] `node esbuild.mjs`
- [x] `env -u TMUX npx vitest run`
- [x] UI proof covering create/edit/paste/import behavior.

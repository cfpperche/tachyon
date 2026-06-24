# Spec 256 - Pin Studio Excalidraw sketches - tasks

**Status:** planned only. Do not implement until the maintainer accepts the scope and open questions are resolved.

## Pre-plan

- [x] Confirm v2 scope from spec 255: Excalidraw sketch blocks and editable scenes are v2; Tiptap rich pins are already v1.
- [x] Check current Excalidraw official docs and npm package facts for Preact integration, asset hosting, API shape, version, and license.
- [x] Draft `spec.md`, `plan.md`, and `tasks.md` in the same worktree/branch as spec 255.
- [x] Ask Claude for a read-only spec review before coding.
- [x] Fold Claude's required spec changes: attachment union, schemaVersion 1/2 read contract, Preact aliases, on-demand bundle, scene normalization, and CSP acceptance.
- [ ] Resolve OQ2-OQ3 before implementation starts.

## Implementation

- [ ] 1. Add `@excalidraw/excalidraw`; configure a separate on-demand `dist/webview/excalidraw.js` bundle with `react`/`react-dom`/JSX runtime aliases to Preact compatibility modules and any required `process.env.IS_PREACT` define.
- [ ] 2. Prove the Excalidraw bundle path with a nonblank render/canvas smoke test and a bundle inspection that does not show a duplicate React runtime.
- [ ] 3. Extend attachment types into an `image | excalidraw` discriminated union while keeping existing v1 image attachment JSON readable.
- [ ] 4. Add resolved sketch metadata with independent `scenePath`/`previewPath` and `sceneAvailable`/`previewAvailable` flags.
- [ ] 5. Generalize `PinAttachmentStore` into a visual artifact store for image blobs, normalized Excalidraw scene JSON blobs, preview PNG blobs, shared path resolution, and total-size accounting.
- [ ] 6. Add Excalidraw scene normalization that strips data URLs into Tachyon blobs, persists only blob refs, and reconstructs renderable files transiently for the webview.
- [ ] 7. Update `PinStore` to read/validate schemaVersion 1 and 2 detail files, write schemaVersion 2 for v2 saves, and preserve legacy/text-only lazy behavior.
- [ ] 8. Add tests for schemaVersion 1 compatibility, schemaVersion 2 sketch details, independent missing scene/preview availability, stable sketch attachment ids, and no automatic blob GC.
- [ ] 9. Add a Tiptap `tachyonSketch` node and document normalization/pruning so persisted docs contain attachment ids only.
- [ ] 10. Add Excalidraw editor UI inside Pin Studio with stable dimensions, local theme, Save/Cancel, dirty-state behavior, and visible bundle-load failure handling.
- [ ] 11. Add host/webview messages to store normalized scene JSON and preview PNG through Tachyon blobs; normalize Excalidraw files so no data URLs persist in detail JSON or scene blobs.
- [ ] 12. Add "Insert sketch" for blank sketches.
- [ ] 13. Add "Annotate" action for existing image attachments, creating a sketch with the original image as a background/reference without mutating the original image.
- [ ] 14. Add sketch preview rendering, missing-artifact rendering, edit/reopen behavior, and save-close-reopen round-trip behavior in Pin Studio.
- [ ] 15. Extend `get_pin` to return sketch scene/preview metadata and independent availability flags while keeping all binary/scene payloads out of the tool response.
- [ ] 16. Keep sidebar `FleetVM` summary-only and update visual attachment count/copy for sketches.
- [ ] 17. Package Excalidraw CSS/fonts/assets under `dist/webview`, set `window.EXCALIDRAW_ASSET_PATH`, and tighten CSP/localResourceRoots plus any required `connect-src`/`worker-src`/`blob:` allowances.
- [ ] 18. Add UI/harness coverage for blank sketch, annotate screenshot, edit sketch, cancel, reload, missing artifact, on-demand bundle load, zero CSP console violations, and nonblank preview/canvas smoke.
- [ ] 19. Re-scan persisted demo artifacts and code for forbidden payloads: `data:image`, `base64`, `blob:`, `vscode-webview`, absolute local paths in detail JSON and scene blobs.

## Verification

- [ ] `npx tsc --noEmit`
- [ ] `npx tsc -p tsconfig.webview.json --noEmit`
- [ ] `bash scripts/check-engine-boundary.sh`
- [ ] `node esbuild.mjs`
- [ ] `env -u TMUX npx vitest run`
- [ ] `npm audit --omit=dev --json`
- [ ] Dogfood in `/home/goat/tachyon-examples`: create blank sketch, annotate screenshot, edit saved sketch, cancel edits, reload EDH, delete pins, and sweep `.tachyon/pins`.
- [ ] Payload scan over dogfood `.tachyon/pins.json`, `.tachyon/pins/*.json`, and scene blobs for `data:image|base64|blob:|vscode-webview|/home/|/mnt/`.

## Notes

- V2 intentionally keeps share/promote and agent-authored annotations out of scope. Those need their own specs if we want them later.

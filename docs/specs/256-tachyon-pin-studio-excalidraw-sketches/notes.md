# Spec 256 - Pin Studio Excalidraw sketches - notes

_Created 2026-06-24._

## Design decisions

### 2026-06-24 - parent - V2 scope

V2 is scoped to Excalidraw sketch blocks inside Pin Studio, including blank sketches and annotating existing screenshot attachments. It does not include a global whiteboard, notes revival, share/promote workflow, real-time collaboration, or agent-created sketches.

### 2026-06-24 - codex - Excalidraw research baseline

Official Excalidraw docs and npm metadata were checked before planning. Relevant constraints: the package is currently `0.18.1` and MIT; docs describe a Preact build path via `process.env.IS_PREACT`; the package also declares React peer dependencies; fonts/assets should be self-hosted for non-CDN use; and Excalidraw scenes can surface `files` through `onChange`, so Tachyon must normalize those files into local blobs rather than persisting data URLs.

### 2026-06-24 - claude-exec - Read-only spec review

Claude reviewed `spec.md` read-only and returned `SPEC-READY-WITH-CHANGES`.

Run artifact: `/home/goat/Agent0/.agent0/.runtime-state/claude-exec/20260624T174459Z-spec-256-pin-studio-excalidraw-review/last-message.md`

Required changes identified:

- Define the v2 attachment union explicitly (`image` vs `excalidraw`) and the resolved sketch shape with separate scene/preview paths and availability flags.
- Make the schemaVersion read contract explicit: `PinStore.readDetail` must accept and validate schemaVersion 1 and 2, not just say "backward-compatible".
- Promote Excalidraw/Preact bundling from an open question into a decision: Claude argues `process.env.IS_PREACT` alone is insufficient for Tachyon's npm-package consumer path and that esbuild aliasing to `preact/compat` should be specified/proven.
- Decide whether Excalidraw is an on-demand bundle following Tachyon's mermaid/katex pattern, or justify inlining it into `pin-studio.js`.
- Add a normalization round-trip acceptance criterion for Excalidraw scene files/images, including whether the no-`data:image`/`base64` rule applies to scene blobs as well as detail JSON.
- Broaden CSP acceptance beyond fonts/assets: enumerate needed `connect-src`/`worker-src`/`blob:` handling and require a smoke test with zero CSP console violations.

### 2026-06-24 - codex - Claude review folded

Folded the Claude required changes into `spec.md`, `plan.md`, and `tasks.md`.

Closed decisions:

- V2 attachments are an explicit `image | excalidraw` discriminated union.
- Resolved sketch attachments expose `scenePath`/`previewPath` and independent availability flags.
- `PinStore.readDetail` must accept and validate schemaVersion 1 and 2.
- Excalidraw ships as an on-demand `dist/webview/excalidraw.js` bundle.
- React peer imports must resolve through Preact compatibility aliases; `process.env.IS_PREACT` alone is not the contract.
- Tachyon-normalized scene blobs must also be free of `data:image`, base64, `blob:`, `vscode-webview`, and absolute local paths.
- CSP acceptance now includes required `connect-src`, `worker-src`/`child-src`, and `blob:` handling if the implementation proves Excalidraw needs them.

## Deviations

## Tradeoffs

## Open questions

- OQ2: resolved by implementation. Preview PNG export happens inside the Excalidraw webview bundle and is persisted through the host as a Tachyon blob.
- OQ3: resolved by implementation. The Excalidraw editor is a contained full-panel modal inside Pin Studio.

## Implementation notes

### 2026-06-24 - codex - Local implementation and validation

Implemented the v2 storage/UI path on top of spec 255:

- Added `@excalidraw/excalidraw` as an on-demand `dist/webview/excalidraw.js` bundle. The implementation uses `0.17.6` rather than latest `0.18.1` because `0.18.1` introduced production audit findings through its transitive dependency graph; `0.17.6` keeps `npm audit --omit=dev --json` clean.
- Configured esbuild aliases for `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, and `react/jsx-dev-runtime` to Preact compatibility/runtime modules, plus `process.env.IS_PREACT = "true"` for Excalidraw's Preact package path.
- Added schemaVersion 2 `image | excalidraw` attachments, normalized Excalidraw scene blobs, transient scene rehydration for the webview, sketch previews, blank sketch insertion, screenshot annotation, edit/reopen support, and summary-only sidebar/Bridge behavior.
- The bundle inspection reported `reactInputs: []` and Preact inputs only.
- Chrome headless smoke loaded the built Excalidraw bundle from `dist/webview`, registered the Tachyon bridge, rendered 2 canvases with painted pixels, exported a preview, and captured zero script errors.
- Validation passed: `npx tsc --noEmit`, `npx tsc -p tsconfig.webview.json --noEmit`, `bash scripts/check-engine-boundary.sh`, `node esbuild.mjs`, `env -u TMUX npx vitest run` (82 files / 1286 tests), and `npm audit --omit=dev --json` (0 vulnerabilities).

Remaining before merge: EDH dogfood in `/home/goat/tachyon-examples` and a payload sweep of the real dogfood `.tachyon/pins` artifacts.

### 2026-06-24 - codex - Dogfood fixes and headless proof

Manual EDH dogfood found two bugs before a successful save:

- Persisting a sketch rejected Excalidraw's root `source` field when it contained a webview URL. Fix: normalize root `scene.source` to `tachyon-pin-studio` before the forbidden-payload scan, while still rejecting forbidden local/inline payloads in other fields.
- Deleting an image/sketch block from the Tiptap document left the item visible in the Pin Studio `Visuals` column until save. Fix: subscribe to Tiptap updates and render the column from direct document attachments only; save still retains internal dependencies such as an annotated sketch's base image attachment. Content-addressed blobs remain conservative on disk.
- Annotated sketches produced a sidebar count drift: the pin summary counted persisted attachments (`image` base + `excalidraw` sketch) while Pin Studio showed one direct visual. Fix: summary `attachmentCount` now counts direct visual attachment refs from the Tiptap document, with an attachment-length fallback for legacy/degenerate details.

Added `test/unit/pinSketchDogfood.test.ts`, covering blank sketch, screenshot annotation, edit with stable id, cancel/no-mutation, remove visual metadata, Bridge-shaped detail without scene/base64 payloads, and persisted payload hygiene.

Headless evidence:

- Chrome smoke loaded `dist/webview/excalidraw.js`, mounted Excalidraw, rendered 2 canvases with painted pixels, exported preview base64, and captured zero script errors.
- Focused headless contract run passed: `test/unit/pinSketchDogfood.test.ts`, `pinAttachmentStore.test.ts`, `pinStudioPanel.test.ts`, `pinStudioView.test.ts`, and `bridge.test.ts` (41 tests).
- Full suite passed after the dogfood fixes: `env -u TMUX npx vitest run` = 83 files / 1289 tests.
- Demo sweep after failed saves found `.tachyon/pins.json` still empty, no `p-*.json` detail files, and no forbidden persisted payload matches under `.tachyon/pins`.
- Final EDH dogfood passed for blank sketch save/reopen, live sketch edit preview refresh, screenshot annotate save, direct-visual `Visuals` list, and delete cleanup. Final demo sweep found `.tachyon/pins.json` empty, no active `p-*.json` detail files, and no forbidden payload strings under `.tachyon/pins`; old content-addressed blobs remain on disk by design.

# 256 - tachyon-pin-studio-excalidraw-sketches - plan

_Drafted from `spec.md` on 2026-06-24. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

Build v2 as a strict extension of the v1 rich-pin boundary. First make storage capable of representing both schemaVersion 1 image-only details and schemaVersion 2 visual attachments with an explicit `image | excalidraw` discriminated union. Then add an Excalidraw editor surface inside the existing Pin Studio panel, saving Tachyon-normalized scene JSON and preview PNGs through the same local content-addressed blob discipline used by v1 screenshots. Only after storage and normalization are tested should the UI expose "Insert sketch" and "Annotate" actions.

The key implementation rule is that Excalidraw can be rich in the webview but boring on disk: persisted detail records contain JSON metadata and blob refs only. Any Excalidraw `files` data URLs, `blob:` URLs, or webview-only preview URIs are transient render inputs and must be normalized back to Tachyon blobs before save, including inside the scene blob. `get_pin` remains a metadata/path reader, not a scene/image streaming API.

Bundle Excalidraw as a separate on-demand webview asset, mirroring the existing Mermaid/KaTeX pattern. Pin Studio loads normally without Excalidraw; only insert/open/annotate sketch loads `dist/webview/excalidraw.js`. The Excalidraw bundle must alias React peer imports to Preact compatibility modules and prove that it renders a nonblank scene without a duplicate React runtime.

## Files to touch

**Create:**

- `src/webview/pin-studio/excalidraw-entry.tsx` - on-demand Excalidraw bundle entry that exports/installs the editor runtime for Pin Studio.
- `src/webview/pin-studio/excalidraw.tsx` - Excalidraw editor component, Preact compatibility integration, theme/dimensions, onChange state capture, save/cancel actions, and scene preview export.
- `src/webview/pin-studio/sketchNode.ts` - Tiptap custom node for `tachyonSketch`, render model conversion, and commands to insert/open sketches.
- `src/pins/ExcalidrawSceneStore.ts` or equivalent helper - validates/normalizes Excalidraw scene JSON, strips data URLs into Tachyon blobs, reconstructs transient Excalidraw files for the webview, and writes preview PNG blobs.
- `test/unit/pinSketchStore.test.ts` - schemaVersion 1/2 reads, sketch attachment save/read, missing scene/preview availability, stable attachment id on edit, and remove-metadata-without-blob-GC behavior.
- `test/unit/pinStudioSketchView.test.ts` - browser-side sketch reducer/view-model tests for insert, annotate, edit, cancel, and render normalization.
- `test/unit/excalidrawArtifactStore.test.ts` - scene JSON validation, preview/image blob publication, data URL stripping, and path containment.

**Modify:**

- `package.json` and `package-lock.json` - add `@excalidraw/excalidraw`; handle React peer imports through Preact compatibility aliases rather than adding React as a Tachyon webview runtime.
- `esbuild.mjs` - add a separate on-demand Excalidraw bundle, alias `react`, `react-dom`, `react/jsx-runtime`, and `react/jsx-dev-runtime` to Preact compatibility/runtime modules, define `process.env.IS_PREACT` if required, include/copy Excalidraw CSS/assets/fonts, and keep existing bundles working.
- `tsconfig.webview.json` - include Excalidraw sketch webview files.
- `src/pins/types.ts` - turn pin attachments into a discriminated union: existing `image` plus new `excalidraw` sketch attachment metadata; add resolved sketch shape with separate scene/preview paths and availability flags.
- `src/pins/PinAttachmentStore.ts` - generalize from image-only storage to visual artifacts: `putImage`, `putExcalidrawScene`, `putPreviewImage`, shared blob write/resolve helpers, independent scene/preview availability, and total byte accounting.
- `src/pins/PinStore.ts` - accept and validate schemaVersion 1 and 2, write schemaVersion 2 on v2 saves, resolve sketch scene/preview paths independently, and keep legacy/text-only behavior unchanged.
- `src/webview/PinStudioPanel.ts` - add host messages for sketch scene/preview persistence, reconstruct renderable sketch/image files for webview load, extend CSP/localResourceRoots for Excalidraw assets and any required `connect-src`/`worker-src`/`blob:` allowances, and keep one-panel-per-pin reuse.
- `src/webview/pin-studio/types.ts` - add sketch attachment VMs, Excalidraw host/webview messages, scene/preview availability fields, and dirty/cancel state.
- `src/webview/pin-studio/document.ts` - normalize `tachyonSketch` nodes, prune unreferenced sketch metadata on save, and ensure persisted nodes contain only attachment ids.
- `src/webview/pin-studio/App.tsx` and `tiptap.ts` - expose Insert sketch, image Annotate action, sketch preview rendering, edit/open behavior, and missing-artifact states.
- `src/bridge/tools.ts` - extend `get_pin` output for sketch attachments with workspace-relative `scenePath`/`previewPath` and independent availability flags; keep no inline JSON/binary.
- `src/sidebar/types.ts`, `src/webview/SidebarPrototype.ts`, and `src/webview/sidebar/App.tsx` - keep summary-only data, but count image and sketch visual attachments consistently.
- `test/unit/bridge.test.ts` - assert `get_pin` sketch metadata shape and absence of scene/base64 payloads.
- `test/unit/pinStudioPanel.test.ts` - host message tests for sketch artifact persistence, localResourceRoots, CSP asset allowance, and cancel/no-write behavior.
- `test/unit/pinStudioView.test.ts` - extend existing Pin Studio tests for `tachyonSketch` document normalization.
- `test/unit/sidebar` coverage or existing sidebar tests - assert sketches do not leak scene/preview payload into `FleetVM`.

**Delete:**

- None.

## Alternatives considered

### Store Excalidraw scenes inline in `.tachyon/pins/<pin-id>.json`

Rejected because scenes can become large, include image-file metadata, and would make every detail read heavier. V2 keeps the detail file as metadata plus content-addressed refs, matching the v1 decision to keep rich bytes outside `pins.json`.

### Render sketches only as flattened PNGs

Rejected because the main value of Excalidraw is editable vector scenes. A flattened PNG is enough for display but loses the ability to revise annotations when the pin changes.

### Build a standalone Tachyon whiteboard panel

Rejected because it recreates the free-form notes surface that spec 253 retired. Sketches must stay attached to pins so they have ownership, lifecycle, and checklist context.

### Include share/promote workflow in v2

Rejected for this spec. Share/promote is useful, but it changes the local/gitignored contract from spec 255 and needs separate UX for committed artifacts, missing assets on other machines, and repository history expectations. V2 should prove sketch editing first.

### Let Excalidraw persist data URLs in scene files

Rejected because it violates the v1 no-base64 persistence rule, bloats local files, and risks leaking large payloads through `get_pin`. Excalidraw `files` must be normalized through Tachyon blobs.

### Inline Excalidraw into `pin-studio.js`

Rejected because Tachyon already isolates large webview dependencies such as Mermaid and KaTeX into on-demand bundles. Excalidraw should not increase the startup cost of every text-only/image-only Pin Studio open.

### Add React to satisfy Excalidraw peers

Rejected unless a build spike proves Preact compatibility is impossible and the maintainer explicitly revisits the choice. Tachyon webviews are Preact bundles; the planned path is `preact/compat` aliasing plus a nonblank render smoke test, not a second UI runtime.

## Risks and unknowns

- Excalidraw's package declares React peer dependencies even though it documents Preact integration. Implementation must prove the final webview bundle resolves React imports through Preact compatibility aliases and does not carry a duplicate React UI stack unintentionally.
- Excalidraw assets/fonts default to CDN loading unless self-hosted. VS Code webview CSP/localResourceRoots and `connect-src`/`worker-src`/`blob:` allowances must be tested with console CSP violations treated as failures.
- Excalidraw preview export may require browser canvas APIs that are awkward in Vitest. Expect a split between unit tests for serialization and a UI harness/dogfood test for real canvas output.
- Image elements inside Excalidraw scenes may use a `files` map with data URLs. The normalization boundary must be precise or base64 can leak into persisted detail files or scene blobs.
- SchemaVersion 2 must not break v1 schemaVersion 1 rich pins. A failed reader migration would make existing v1 pins appear corrupt.
- Canvas dimensions can be zero if the Excalidraw container is hidden or not sized. The UI must allocate stable dimensions before rendering.
- On-demand loading adds an async failure mode: Pin Studio must handle an Excalidraw bundle load failure with a visible error that does not corrupt the pin.

## Research / citations

- `docs/specs/255-tachyon-pin-studio-rich-pins/spec.md` - v1 shipped Tiptap, deferred Excalidraw to v2, and established the local rich-detail contract.
- `src/pins/PinAttachmentStore.ts` and `src/pins/PinStore.ts` - v1 blob and detail boundaries to extend.
- Excalidraw official installation docs - package install, self-hosted fonts/assets, and nonzero container dimensions: https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/installation
- Excalidraw official integration docs - module import and Preact build flag `process.env.IS_PREACT`: https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/integration
- Excalidraw official props docs - `onChange(elements, appState, files)`, `initialData`, theme, dimensions, file id generation: https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/api/props
- Excalidraw official utils docs - `serializeAsJSON`, `loadFromBlob`, `loadSceneOrLibraryFromBlob`, and export/restore utilities: https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/api/utils
- Excalidraw FAQ - `process.env.IS_PREACT` / `process` build requirement: https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/faq
- Excalidraw GitHub README - MIT license, open-source editor, open `.excalidraw` JSON format, image support, export support: https://github.com/excalidraw/excalidraw
- `npm view @excalidraw/excalidraw version license peerDependencies dependencies --json` on 2026-06-24 - current package version `0.18.1`, MIT license, React peer dependency declarations.

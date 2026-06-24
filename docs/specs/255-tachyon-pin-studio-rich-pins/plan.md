# 255 — tachyon-pin-studio-rich-pins — plan

_Drafted from `spec.md` on 2026-06-24. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

Build this from the durable data boundary inward, then wire the UI. The existing `.tachyon/pins.json` remains the summary index used by sidebar and `list_pins`; rich state is an optional local detail layer under `.tachyon/pins/`. First extend the pin model and add a content-addressed attachment store with the same temp+rename publication discipline as Activity blobs. Then expose a narrow `get_pin` Bridge read that returns detail metadata and workspace-relative paths, while keeping existing summary tools unchanged.

After storage and Bridge contracts are stable, add an editor-area Pin Studio panel. Existing commands (`tachyon.addPin`, sidebar `+`, and pin Edit) should route into the Studio instead of `showInputBox`. The webview bundle uses Tiptap core directly from Preact, with Tachyon-owned toolbar/chrome and transient host messages for paste/drop/imported bytes. Persisted documents store attachment references, not webview URIs or base64; the host resolves image previews with `asWebviewUri` on load. The sidebar stays a dense checklist and receives only summary fields plus attachment count/indicator.

## Files to touch

**Create:**

- `src/pins/PinAttachmentStore.ts` — validates image MIME/size, stores blobs under `.tachyon/pins/blobs/<sha256>` via unique temp+rename, computes workspace-relative paths, reports total blob size, and never follows paths outside the pin blob root.
- `src/webview/PinStudioPanel.ts` — VS Code host panel for create/edit, CSP/localResourceRoots, one-panel-per-workspace+pin reuse, load/save/import message handling, and `asWebviewUri` resolution.
- `src/webview/pin-studio/main.tsx` — Preact webview entrypoint.
- `src/webview/pin-studio/App.tsx` — Pin Studio UI: title, Tiptap editor, toolbar/slash palette, attachment/import affordances, Save/Cancel/error states.
- `src/webview/pin-studio/tiptap.ts` — framework-neutral Tiptap setup, extensions, document normalization, image node attachment attrs, and command helpers.
- `src/webview/pin-studio/types.ts` — host/webview message and view-model types.
- `test/unit/pinAttachmentStore.test.ts` — blob validation, dedup, temp+rename, path containment, and total-size warning tests.
- `test/unit/pinRichStore.test.ts` — detail read/write/delete, legacy fallback, missing blob availability, and shared-blob delete behavior.
- `test/unit/pinStudioView.test.ts` — browser-side message reducer/editor model tests for create/edit/paste/import flows.
- `test/unit/pinStudioPanel.test.ts` or extension-host coverage in an existing suite — command routing and single-panel reuse where the VS Code mock seam can support it.

**Modify:**

- `package.json` and `package-lock.json` — add the OSS/framework-neutral Tiptap packages named in the spec; do not add `@tiptap/react`, Pro UI packages, DragHandle, or Excalidraw.
- `esbuild.mjs` — add a `pin-studio.js` browser bundle and include it in build/watch.
- `tsconfig.webview.json` — include `src/webview/pin-studio/**/*.ts(x)`.
- `src/pins/PinStore.ts` — extend `Pin` with optional `updatedAt`, `detail`, and `attachmentCount`; add detail APIs for create/read/save/delete while preserving existing summary CRUD contracts.
- `src/init/initLogic.ts` — add `.tachyon/pins/` to machine-local gitignore entries, keep `.tachyon/pins.json` shareable, and update tests.
- `src/bridge/tools.ts` — register `get_pin`; keep `create_pin`, `list_pins`, `complete_pin`, and `update_pin` summary-level and binary-free.
- `src/workspace/Workspace.ts` — pass the richer `PinStore` through unchanged to Bridge; add any narrow host seam only if Pin Studio needs workspace-owned lifecycle cleanup.
- `src/extension.ts` — replace Add/Edit pin `showInputBox` flow with Pin Studio opening, preserve programmatic `tachyon.addPin("text")` behavior for callers that pass preset text, and refresh sidebar after save/delete.
- `src/webview/SidebarPrototype.ts` — include `attachmentCount`/`detail` in `FleetVM.pins`, preserve only lightweight summary fields, and keep unknown global ops explicit.
- `src/sidebar/types.ts` — extend `PinVM` with optional `detail` and `attachmentCount`.
- `src/webview/sidebar/App.tsx` — render attachment indicator/count and keep Edit/Delete routing.
- `package.nls.json` and `package.nls.pt-br.json` — update strings only if a new contributed command or visible command title is required; otherwise existing Add/Edit pin strings can remain.
- `test/unit/pins.test.ts` — add backward-compatibility assertions for optional fields and `updatedAt` stamping.
- `test/unit/bridge.test.ts` and `test/unit/auth.test.ts` — update tool count/list expectations and add `get_pin` behavior tests for rich, legacy, missing id, and no binary/base64 payloads.
- `test/unit/init.test.ts` — assert `.tachyon/pins/` is ignored while `.tachyon/pins.json` is not.
- `test/unit/sidebarActions.test.ts` or a sidebar view-model test — assert attachment indicator/count is summary-only.

**Delete:**

- None. Excalidraw is deferred by absence: no dependency, bundle, command, or UI import should be added in v1.

## Alternatives considered

### Store screenshots as base64 in `.tachyon/pins.json`

Rejected because it would bloat the sidebar model, `list_pins`, diffs, and MCP payloads. The spec explicitly keeps `pins.json` as a small checklist index and Activity already provides the better precedent: content-addressed blobs outside the render/list model.

### Make rich pin detail files shareable by default

Rejected because local screenshots would create broken references on other machines unless the whole asset promotion/share workflow shipped at the same time. V1 keeps `.tachyon/pins/` local/gitignored and leaves `.tachyon/pins.json` as the shareable coordination surface.

### Use Tiptap React wrappers or Pro UI components

Rejected because Tachyon webviews are Preact bundles and the spec requires an OSS, framework-neutral integration. Direct `@tiptap/core` plus Tachyon-owned Preact chrome keeps bundle ownership clear and avoids React compatibility drift.

### Ship Excalidraw in v1

Rejected because screenshot-rich pins are already a large UI/storage/API change, and Excalidraw brings a separate whiteboard app surface plus Preact build configuration. V1 should finish rich pins; v2 can add sketch scenes deliberately.

## Risks and unknowns

- Tiptap without a framework wrapper may need a small lifecycle adapter to avoid editor leaks on Preact unmount.
- Paste/drop images must cross the webview-host boundary transiently; the implementation must bound payload size before posting/saving and must never persist transient base64.
- Persisted image nodes need a canonical attachment reference and a render-time `asWebviewUri` rewrite. Saving webview URIs into detail files would be a bug.
- UI proof may need a pragmatic harness around the Preact/Tiptap bundle plus a separate extension-host command-routing check, because VS Code webviews are not naturally driven by Vitest alone.
- Detail writes must be atomic enough that a failed save cannot leave `pins.json` saying `detail: true` while the detail file is absent.
- Blob GC is best-effort, but delete must not remove a content-addressed blob still referenced by another pin.

## Research / citations

- `docs/specs/255-tachyon-pin-studio-rich-pins/spec.md` — maintainer decision, acceptance criteria, storage contract, and non-goals.
- `src/pins/PinStore.ts` — existing summary-only pin store and compatibility boundary.
- `src/activity/logStore.ts` — content-addressed blob precedent with temp+rename publication.
- `src/init/initLogic.ts` — existing `.tachyon` gitignore policy; add `.tachyon/pins/` without ignoring `pins.json`.
- `src/bridge/tools.ts` and `test/unit/bridge.test.ts` — Bridge tool registration and tool-list assertion surface.
- `src/webview/SidebarPrototype.ts`, `src/sidebar/types.ts`, and `src/webview/sidebar/App.tsx` — sidebar view-model and global/section dispatch seams.
- `src/webview/ActivityPanel.ts` and `src/webview/HandoffPanel.ts` — editor-area webview CSP, `localResourceRoots`, shared design-system, and message-handling examples.
- Tiptap FileHandler docs: https://tiptap.dev/docs/editor/extensions/functionality/filehandler
- Tiptap Image docs: https://tiptap.dev/docs/editor/extensions/nodes/image
- VS Code Webview docs: https://code.visualstudio.com/api/extension-guides/webview
- Excalidraw integration docs: https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/integration

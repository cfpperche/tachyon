# Spec 256 - Pin Studio Excalidraw sketches

**Status:** shipped
**Closure:** Landed in commit `b345da96`; the original status records completed EDH dogfood and payload sweep.
**Status detail:** implemented locally; EDH dogfood and payload sweep complete before merge.
**Surface:** Pin Studio v2 adds Excalidraw-powered sketch blocks and screenshot annotation on top of the rich pin storage shipped in spec 255.
**UI impact:** ui.
**Verify:** `npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit && bash scripts/check-engine-boundary.sh && node esbuild.mjs && env -u TMUX npx vitest run`

> **Origin.** Spec 255 intentionally shipped Tiptap rich pins first and deferred Excalidraw to v2. Now that v1 is implemented, dogfooded, and pushed on `tachyon/spec-255-pin-studio-rich-pins`, v2 should add the drawing/annotation capability without weakening the v1 guarantees: pins remain the coordination surface, `.tachyon/pins.json` remains a small summary index, rich detail stays local by default, and no binary/base64 payload enters sidebar or MCP list payloads.

## Problem

Spec 255 lets users pin screenshots and rich written context, but screenshots often need visual markup: arrows, boxes, labels, quick diagrams, or a hand-drawn explanation of a UI state. Without a drawing surface, users either describe the annotation in prose or leave Tachyon to external tools, losing the pin-local context.

The hard part is not drawing itself. It is integrating Excalidraw into a VS Code webview and pin storage without creating payload bloat, broken local references, duplicate React/Preact runtime problems, or a second "notes-like" free-form surface.

## Goal

Add an Excalidraw-backed **sketch block** to Pin Studio. A user can create a blank sketch inside a rich pin, or annotate an existing screenshot attachment. Saving a sketch stores an editable Excalidraw scene plus a rendered preview under the existing local pin artifact tree. The Tiptap document embeds a lightweight sketch node that renders the preview and opens the sketch editor for editing.

V2 is deliberately local-first and pin-scoped:

- the Excalidraw scene is editable later;
- a PNG preview renders inline in Pin Studio;
- `get_pin` exposes scene/preview metadata and workspace-relative paths for local agents;
- `.tachyon/pins.json` and sidebar `FleetVM` remain summary-only;
- no Excalidraw scene JSON, preview bytes, or base64 is sent through `list_pins`.

## Decisions

- **D1 - Excalidraw is a pin sketch block, not a standalone notes surface.** Sketches only live inside rich pins. There is no new `.tachyon/notes.md`, no global whiteboard, and no separate coordination model.
- **D2 - Scope includes blank sketches and annotate-existing-image.** A blank sketch covers diagrams. Annotating an existing screenshot covers the most common dogfood need from v1.
- **D3 - Store editable scene and rendered preview separately.** The scene is the source of truth for editing; the preview is the fast inline visual. Both are local pin artifacts under `.tachyon/pins/`.
- **D4 - Detail schema becomes version 2, read contract is `schemaVersion: 1 | 2`.** Existing schemaVersion 1 rich details load without migration or rewrite. V2 saves write schemaVersion 2. `PinStore.readDetail` must validate both attachment shapes rather than assuming the v1 image-only shape.
- **D5 - Drawing files are metadata, not MCP payloads.** `get_pin` returns workspace-relative scene/preview paths and availability flags. It never returns scene JSON inline by default and never returns image/base64 bytes.
- **D6 - No automatic blob garbage collection.** Deleting a pin or removing a sketch block removes summary/detail/attachment metadata as applicable, but content-addressed blobs remain conservative and local, matching v1 delete semantics.
- **D7 - Excalidraw must run through Tachyon's Preact bundle boundary.** Tachyon webviews are Preact bundles. The Excalidraw npm package declares React peers, so v2 must use a dedicated esbuild configuration that aliases `react`, `react-dom`, `react/jsx-runtime`, and `react/jsx-dev-runtime` to `preact/compat` / Preact runtime equivalents, and may also define `process.env.IS_PREACT` where Excalidraw requires it. A nonblank render smoke test is the gate; if the package cannot be made to run without pulling a duplicate React runtime, implementation stops.
- **D8 - Self-host required Excalidraw assets.** VS Code webviews should not depend on Excalidraw downloading fonts/assets from a CDN. The bundle must package required assets under `dist/webview` and set `window.EXCALIDRAW_ASSET_PATH` accordingly.
- **D9 - Image files inside scenes are normalized through Tachyon blobs.** If Excalidraw produces scene `files` for screenshot backgrounds or pasted images, persisted scene JSON must store blob references, not data URLs. The webview can reconstruct renderable files transiently for Excalidraw.
- **D10 - Excalidraw is an on-demand bundle.** Follow the existing Mermaid/KaTeX pattern: Pin Studio stays the always-loaded editor bundle, while Excalidraw is a separate `dist/webview/excalidraw.js` loaded only when the user inserts/opens/annotates a sketch.

## Proposed storage contract

Existing summary pins stay unchanged. Rich detail files may be `schemaVersion: 1` (spec 255 image-only detail) or `schemaVersion: 2` (image and sketch attachments). `schemaVersion: 1` remains readable as-is; Tachyon does not rewrite it on startup or read.

V2 attachment metadata is a discriminated union. The v1 image shape remains valid:

```ts
type PinAttachment = ImagePinAttachment | ExcalidrawPinAttachment;

interface ImagePinAttachment {
  id: string;
  kind: "image";
  blobRef: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  name: string;
  size: number;
  width?: number;
  height?: number;
  createdAt: string;
  source: "paste" | "drop" | "import";
  visibility: "local";
}

interface ExcalidrawPinAttachment {
  id: string;
  kind: "excalidraw";
  name: string;
  sceneBlobRef: string;
  previewBlobRef: string;
  sceneMediaType: "application/vnd.tachyon.excalidraw+json";
  previewMediaType: "image/png";
  sceneSize: number;
  previewSize: number;
  elementCount: number;
  createdAt: string;
  updatedAt: string;
  source: "blank" | "annotate-image";
  baseImageAttachmentId?: string;
  visibility: "local";
}
```

Resolved attachments returned by host code and `get_pin` must also be discriminated. Image attachments keep the v1 single `path` / `available` fields. Sketch attachments return independent scene and preview paths:

```ts
interface ResolvedExcalidrawPinAttachment extends ExcalidrawPinAttachment {
  scenePath: string;
  sceneAvailable: boolean;
  previewPath: string;
  previewAvailable: boolean;
}
```

Example schemaVersion 2 detail:

```json
{
  "schemaVersion": 2,
  "pinId": "p-abc123",
  "doc": {
    "type": "doc",
    "content": [
      {
        "type": "tachyonSketch",
        "attrs": {
          "attachmentId": "att-sketch1"
        }
      }
    ]
  },
  "attachments": [
    {
      "id": "att-sketch1",
      "kind": "excalidraw",
      "name": "Auth flow annotation",
      "sceneBlobRef": "sha256...",
      "previewBlobRef": "sha256...",
      "sceneMediaType": "application/vnd.tachyon.excalidraw+json",
      "previewMediaType": "image/png",
      "sceneSize": 48212,
      "previewSize": 184321,
      "elementCount": 14,
      "createdAt": "2026-06-24T00:00:00.000Z",
      "updatedAt": "2026-06-24T00:04:00.000Z",
      "source": "annotate-image",
      "baseImageAttachmentId": "att-image1",
      "visibility": "local"
    }
  ]
}
```

Candidate paths stay under the v1 local tree:

- `.tachyon/pins/<pin-id>.json` - schemaVersion 1 or 2 rich detail document.
- `.tachyon/pins/blobs/<sha256>` - content-addressed scene JSON, preview PNG, and image files used by scenes.

The scene blob is a Tachyon-normalized Excalidraw scene JSON, not necessarily a raw Excalidraw export. It stores Excalidraw elements/appState plus normalized file references whose binary data lives in Tachyon blobs. It must not contain `data:image`, base64 image data, `blob:`, `vscode-webview`, or absolute machine paths. On load, the host/webview reconstructs Excalidraw's renderable `files` map transiently from blob refs.

The existing `PinAttachmentStore` should evolve into a visual artifact store rather than become screenshot-only. It must continue to support v1 image attachments exactly as before.

## V2 behavior

- Pin Studio exposes an "Insert sketch" command in the editor UI.
- Existing image attachments expose an "Annotate" action that opens Excalidraw with that image as the background/reference.
- The Excalidraw editor opens inside Pin Studio, either as a focused editor mode or a contained editor panel, not as an external browser.
- Save from Excalidraw updates the sketch attachment metadata, writes a scene JSON blob, writes a PNG preview blob, updates the Tiptap sketch node, refreshes the inline preview, and keeps the containing Pin Studio dirty state coherent.
- Cancel from Excalidraw returns to the pin editor without mutating the persisted pin.
- Reopening a saved sketch loads the same editable scene, including any Tachyon-normalized scene image files.
- Removing a sketch block from the Tiptap document removes that sketch attachment from the next saved detail metadata. Content-addressed blobs remain on disk.
- `get_pin` for a rich pin with sketches returns drawing attachment metadata with scene/preview paths and availability flags.
- Sidebar rows may show the same visual attachment count/indicator as v1, but receive no scene JSON and no preview bytes.
- Excalidraw code is loaded on demand. Opening a text-only or image-only Pin Studio must not load `dist/webview/excalidraw.js`.

## Acceptance

- [ ] **Scenario: Insert a blank sketch**
  - **Given** Pin Studio is open for a rich pin
  - **When** the user invokes Insert sketch and saves a drawing
  - **Then** the pin document contains a `tachyonSketch` node, the detail file is schemaVersion 2, and local blobs exist for the editable Excalidraw scene and PNG preview.

- [ ] **Scenario: Annotate an existing screenshot**
  - **Given** a pin has an image attachment from paste/drop/import
  - **When** the user chooses Annotate for that image and saves an Excalidraw scene
  - **Then** the original image attachment remains intact, a new sketch attachment references it through `baseImageAttachmentId`, and the sketch preview renders inline in Pin Studio.

- [ ] **Scenario: Edit a saved sketch**
  - **Given** a pin has a saved sketch attachment
  - **When** the user opens it, changes the drawing, and saves
  - **Then** the attachment id remains stable, `updatedAt` changes, scene/preview blob refs update as needed, and the Tiptap node still points at the same attachment id.

- [ ] **Scenario: Cancel sketch edits**
  - **Given** Excalidraw is open for an existing sketch
  - **When** the user modifies the scene and cancels
  - **Then** the persisted detail file, attachment metadata, and blob refs remain unchanged.

- [ ] **Scenario: Existing v1 rich pins load without migration**
  - **Given** `.tachyon/pins/<pin-id>.json` is schemaVersion 1 from spec 255
  - **When** Tachyon opens Pin Studio or `get_pin` reads the pin
  - **Then** the pin loads as before, no rewrite occurs, and no sketch fields are required.

- [ ] **Scenario: `get_pin` exposes sketch metadata without payload bloat**
  - **Given** a rich pin has an Excalidraw sketch
  - **When** an agent calls `get_pin`
  - **Then** the response includes sketch metadata, workspace-relative `scenePath`/`previewPath`, separate `sceneAvailable`/`previewAvailable` flags, and no inline scene JSON, image bytes, data URLs, or base64.

- [ ] **Scenario: Sidebar remains summary-only**
  - **Given** a pin has image and sketch attachments
  - **When** the sidebar refreshes
  - **Then** `FleetVM.pins` includes only summary fields and a visual attachment count/indicator, not Excalidraw elements, scene files, preview bytes, or base64.

- [ ] **Scenario: Missing sketch artifacts degrade visibly**
  - **Given** a sketch attachment references a missing scene or preview blob
  - **When** Pin Studio loads the pin
  - **Then** the editor shows a missing-artifact state, `get_pin` marks only the missing scene or preview path as unavailable, and the rest of the pin remains editable.

- [ ] **Scenario: Remove a sketch block**
  - **Given** a pin detail contains a sketch node and matching sketch attachment metadata
  - **When** the user deletes the sketch block and saves the pin
  - **Then** the detail metadata no longer includes that sketch attachment, the summary still saves successfully, and existing content-addressed blobs are not deleted.

- [ ] **Scenario: Normalized scene round-trip**
  - **Given** a sketch scene includes an annotated screenshot and Excalidraw file entries
  - **When** the user saves, closes Pin Studio, reopens the same pin, edits the sketch, and saves again
  - **Then** the scene still renders the screenshot and annotations, all image/file payloads were reconstructed from Tachyon blob refs, and the persisted detail file and scene blob contain no `data:image`, `base64`, `blob:`, `vscode-webview`, or absolute machine paths.

- [ ] **Scenario: Excalidraw loads on demand**
  - **Given** Pin Studio opens a text-only or image-only rich pin
  - **When** the user does not open, insert, or annotate a sketch
  - **Then** the webview does not load `dist/webview/excalidraw.js`; opening a sketch loads that bundle exactly when needed.

- [ ] Excalidraw integration uses `preact/compat` aliases for React peer imports, does not introduce a duplicate React runtime into Tachyon webviews, and the built webview passes a nonblank canvas/render smoke test.
- [ ] Excalidraw fonts/assets needed by the webview are packaged locally and allowed by CSP/localResourceRoots.
- [ ] Pin Studio CSP enumerates every Excalidraw requirement actually used (`img-src`, `font-src`, `connect-src`, `worker-src`/`child-src`, `blob:` if unavoidable), and the UI smoke test asserts zero CSP console violations.
- [ ] Persisted detail files and scene blobs contain no `data:image`, `base64`, `blob:`, `vscode-webview`, or absolute machine paths.
- [ ] Verification includes typecheck x2, engine-boundary, esbuild, full Vitest suite, unit tests for schemaVersion 1/2 reads and artifact normalization, and a UI harness/dogfood proof for blank sketch, annotate screenshot, edit sketch, cancel, and reload.

## Non-goals

- Reintroducing `.tachyon/notes.md`, `get_notes`, `set_notes`, or a global whiteboard outside pins.
- Real-time Excalidraw collaboration or remote sharing.
- A committed/shareable artifact promotion workflow. Rich pin details and sketches remain local/gitignored by default in v2.
- Agent-authored visual annotations or MCP write tools for creating sketches.
- Import/export of `.excalidraw` files as a user-facing workflow unless required for internal tests.
- A general asset manager for all Tachyon surfaces.
- Automatic content-addressed blob garbage collection.

## Open questions

- [x] **OQ1 - Excalidraw package proof.** Resolved by decision D7: use a dedicated Excalidraw bundle with React peer imports aliased to `preact/compat` and prove it with a nonblank render smoke test. `process.env.IS_PREACT` may still be defined where the package requires it, but it is not the whole integration contract.
- [x] **OQ2 - Preview export mechanism.** Resolved: preview PNG is produced inside the Excalidraw webview with Excalidraw export utilities, then stored through the host as a Tachyon blob.
- [x] **OQ3 - Editor placement.** Resolved: Excalidraw opens as a contained full-panel modal inside the existing Pin Studio panel, preserving the one-panel-per-pin rule while giving the canvas stable dimensions.

## Context / references

- Spec 255 - Pin Studio rich pins: v1 storage, Tiptap editor, image attachments, local `.tachyon/pins/` contract, and explicit Excalidraw v2 deferral.
- Spec 253 - retired notes; v2 must not recreate notes as a global whiteboard.
- Spec 252 - shared webview design system and VS Code webview conventions.
- Current v1 seams: `src/pins/PinStore.ts`, `src/pins/PinAttachmentStore.ts`, `src/webview/PinStudioPanel.ts`, `src/webview/pin-studio/*`, `src/bridge/tools.ts`, `src/webview/SidebarPrototype.ts`, `src/webview/sidebar/App.tsx`.
- Excalidraw package docs:
  - https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/installation
  - https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/integration
  - https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/api/props
  - https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/api/utils
  - https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/faq
- Excalidraw repository and package facts checked 2026-06-24:
  - https://github.com/excalidraw/excalidraw
  - `npm view @excalidraw/excalidraw version license peerDependencies dependencies --json` returned version `0.18.1`, license `MIT`, and React peer dependency declarations.

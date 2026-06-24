# Spec 255 — Pin Studio rich pins (Tiptap v1, Excalidraw v2)

**Status:** shipped in isolated worktree (implementation complete; local verification green; review/merge pending). · **Surface:** replace the quick input-box pin authoring flow with a Pin Studio webview: Notion-like Tiptap editor, paste/drop/import screenshots, attachment storage, sidebar summaries, and MCP read access. · **UI impact:** ui. · **Verify:** `npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit && bash scripts/check-engine-boundary.sh && node esbuild.mjs && env -u TMUX npx vitest run`

> **Origin.** Pin `p-86fe67` asks for pins to support screenshots and suggests replacing the retired notes/pins input surface with a Studio webview where the user has a rich editor, drawing/canvas, and richer capture affordances. Spec 253 deliberately retired the free-form `notes` whiteboard, so this must improve **pins** without reintroducing notes as a third coordination surface. The maintainer decision for this draft: **Tiptap / Notion-like editor ships in v1; Excalidraw is explicitly v2**.

## Problem

Pins are useful as a durable checklist, but the current human authoring path is a single `showInputBox` string. That is too thin for the actual things users want to pin during agent work:

- a screenshot of a broken UI, error toast, terminal state, or rendered artifact;
- a short written diagnosis plus supporting visual evidence;
- a paste/drop workflow that feels as immediate as taking a screenshot and annotating it;
- a pin detailed enough for a future agent to inspect without hunting through scrollback.

The current model also has a scaling trap: if screenshots are naively embedded into `.tachyon/pins.json` as base64, the sidebar and MCP `list_pins` payload become large, slow, and noisy. Tachyon already solved this class of problem for Activity images in spec 239: lightweight render records refer to content-addressed blobs, and large image bytes are sent/read separately.

## Goal

Build **Pin Studio**, a first-class editor-area webview for creating and editing rich pins. A pin keeps its checklist identity (`id`, `text`, `done`, `by`, timestamps), but can also have a Tiptap document body and image attachments stored outside the list payload. The sidebar stays dense and checklist-oriented; the Studio is the rich detail surface.

The v1 editor is **Tiptap OSS** with a Notion-like block feel: slash command menu, placeholder blocks, basic formatting, lists/tasks, links/code, image blocks, keyboard-first editing, and a compact floating/bubble toolbar. Screenshots enter through paste/drop/import, not through a new global screen-capture primitive. Excalidraw is deferred to v2 for real whiteboard-style sketching and reusable drawing scenes.

## Decisions

- **D1 — Tiptap in v1.** Use Tiptap's open-source editor stack for the Pin Studio body. This is a product decision: pins become a rich editor surface, not just a textarea with previews.
- **D2 — Excalidraw in v2, not v1.** Excalidraw is the right shape for whiteboard/sketch scenes, but it brings a larger app surface and a Preact integration/build concern (`process.env.IS_PREACT`). v1 must ship screenshot-rich pins before carrying a full drawing canvas.
- **D3 — Use Tiptap directly from Preact, avoid React wrappers.** Tachyon webviews are Preact bundles. The Pin Studio should instantiate Tiptap's framework-neutral editor/core directly and render Tachyon-owned toolbar/chrome, rather than importing `@tiptap/react`.
- **D4 — No base64 in `pins.json`.** Image bytes are never stored in `.tachyon/pins.json` or in the sidebar view-model. Attachments are content-addressed blobs under a pin-owned blob store and referenced by metadata.
- **D5 — Keep `pins.json` a small checklist index.** Existing pins keep working. The list file remains the summary source for sidebar/MCP list views. Rich pin details live in separate per-pin detail files so a long editor body does not inflate every list read.
- **D6 — Rich details and binary attachments are local by default.** The entire `.tachyon/pins/` detail tree is machine-local/gitignored in v1, while `.tachyon/pins.json` stays shareable. This avoids committing detail documents whose image nodes point at missing local blobs on another machine. A later explicit "make shareable" affordance may promote a pin detail + assets to committed paths, but v1 must not silently dump rich screenshots into a user's project history.
- **D7 — Rich detail is readable by local agents, but binary payloads are not streamed through MCP.** Existing pin tools continue to operate on summaries. Add a targeted detail read (`get_pin`) that returns the Tiptap JSON and attachment metadata/paths when local detail exists; do not add a base64-returning MCP tool.
- **D8 — Webview security follows existing Tachyon rules.** Pin Studio uses the shared design system, tight CSP, `asWebviewUri`, bounded `localResourceRoots`, sanitized render paths, explicit media allowlist, and file-size limits.
- **D9 — One Pin Studio editor per pin.** v1 avoids multi-editor merge/CAS complexity by reusing/revealing an already-open Studio for the same workspace+pin. External file edits are not merged live; save writes fresh summary/detail atomically from the active editor state.
- **D10 — Tiptap dependency set is OSS-only and framework-neutral.** v1 uses Tiptap core/editor packages directly with Tachyon-owned Preact chrome. No Tiptap Pro UI components, no React wrappers, and no DragHandle dependency in v1.

## Proposed storage contract

Existing pins remain valid:

```json
{
  "pins": [
    {
      "id": "p-abc123",
      "text": "Investigate slow auth callback",
      "by": "human",
      "createdAt": "2026-06-24T00:00:00.000Z",
      "done": false
    }
  ]
}
```

Rich v1 adds summary metadata without putting the full document or blobs in the list:

```json
{
  "id": "p-abc123",
  "text": "Investigate slow auth callback",
  "by": "human",
  "createdAt": "2026-06-24T00:00:00.000Z",
  "updatedAt": "2026-06-24T00:04:00.000Z",
  "done": false,
  "detail": true,
  "attachmentCount": 2
}
```

Per-pin detail file:

```json
{
  "schemaVersion": 1,
  "pinId": "p-abc123",
  "doc": {
    "type": "doc",
    "content": []
  },
  "attachments": [
    {
      "id": "att-abc123",
      "kind": "image",
      "blobRef": "sha256...",
      "mediaType": "image/png",
      "name": "auth-error.png",
      "size": 184321,
      "width": 1440,
      "height": 900,
      "createdAt": "2026-06-24T00:02:00.000Z",
      "source": "paste",
      "visibility": "local"
    }
  ]
}
```

Candidate paths:

- `.tachyon/pins.json` — small checklist index, backward compatible.
- `.tachyon/pins/<pin-id>.json` — local rich detail document and attachment metadata, ignored by default.
- `.tachyon/pins/blobs/<sha256>` — local content-addressed image blobs, ignored by default.

`updatedAt`, `detail`, and `attachmentCount` are optional summary fields. Legacy pins without them stay valid. `PinStore.update()` and Pin Studio saves stamp `updatedAt`; create-only legacy code does not need to backfill it.

`get_pin` contract:

- Unknown pin id returns a normal tool error (`unknown pin '<id>'`).
- Text-only or legacy pin with no detail file returns the summary with `detail: false`, `doc: null`, and `attachments: []`.
- Rich local pin returns the summary, Tiptap JSON, and attachment metadata.
- Attachment paths are workspace-relative, e.g. `.tachyon/pins/blobs/<sha256>`, plus `available: true|false`. Missing blobs render as broken/missing attachments in Studio and are reported as `available: false`; `get_pin` does not invent absolute machine paths and never streams image bytes.

V1 attachment limits:

- Allowed media types: `image/png`, `image/jpeg`, `image/webp`, `image/gif`.
- Reject SVG and all other formats.
- Default hard limit: **10 MB per image**.
- Soft warning: **50 MB total local pin blobs per workspace**. The warning must not block save.

## V1 behavior

- `Tachyon: Add Pin` and sidebar `+` open Pin Studio instead of `showInputBox`.
- `Edit` on a pin opens Pin Studio with the existing summary, body, and attachments.
- A newly created quick text-only pin is still possible: title only, no body, no attachment.
- Pasting or dropping a PNG/JPEG/WebP/GIF into the editor stores the image as a blob, inserts an image node into the Tiptap document, and shows an inline preview.
- Importing a local image uses a VS Code file picker and the same attachment path.
- The sidebar still renders compact rows: checkbox, title, author, and a small attachment count/image glyph. It does not receive full image data.
- Deleting a pin removes its detail file and unreferenced local attachment metadata. Blob garbage collection can be best-effort in v1; no referenced blob may be deleted.
- `create_pin`, `list_pins`, `complete_pin`, and `update_pin` keep their current contracts for summary-level automation.
- New `get_pin` returns one pin's rich detail. It includes Tiptap JSON and attachment metadata with local file paths for agent inspection, but never inline binary/base64.

V1 Tiptap package target:

- `@tiptap/core`
- `@tiptap/pm`
- `@tiptap/starter-kit`
- `@tiptap/extension-placeholder`
- `@tiptap/extension-link`
- `@tiptap/extension-image`
- `@tiptap/extension-file-handler`
- `@tiptap/extension-task-list`
- `@tiptap/extension-task-item`
- `@tiptap/extension-bubble-menu`
- `@tiptap/extension-floating-menu`

The Notion-like surface comes from Tachyon-owned UI around those primitives: slash command palette, placeholder empty blocks, compact formatting toolbar, keyboard-first commands, and block insertion. Drag handles are deferred unless planning proves a framework-neutral OSS implementation with no Pro dependency.

## V2 behavior (out of scope for v1)

- Excalidraw-based sketch blocks / whiteboard attachments.
- Editable vector scenes stored as structured Excalidraw scene JSON.
- "Open in Excalidraw" for an existing screenshot.
- Share/promote attachment workflow for committed visual artifacts.
- Agent-created visual annotations.

## Acceptance

- [x] **Scenario: Create a rich pin from the sidebar**
  - **Given** a workspace with Tachyon initialized and the sidebar open on the Pins tab
  - **When** the user clicks the Pins `+`
  - **Then** Pin Studio opens in the editor area with an empty Notion-like Tiptap document, a title field, paste/drop/import image affordances, and Save/Cancel actions.

- [x] **Scenario: Save a text-only pin without changing old behavior**
  - **Given** Pin Studio is open for a new pin
  - **When** the user enters only a title and saves
  - **Then** `.tachyon/pins.json` contains a normal summary pin, `list_pins` returns it, and no rich detail file or blob is required.

- [x] **Scenario: Paste a screenshot into a pin**
  - **Given** Pin Studio is open and the clipboard contains an allowed image
  - **When** the user pastes the image into the editor
  - **Then** the image is written once to the pin blob store, the Tiptap document receives an image node referencing the attachment, and the preview renders through `asWebviewUri`.

- [x] **Scenario: Sidebar stays lightweight**
  - **Given** a pin has a rich body and at least one screenshot attachment
  - **When** the sidebar refreshes
  - **Then** the posted `FleetVM` includes only summary pin fields plus attachment count/indicator, not base64 image data or the full Tiptap document.

- [x] **Scenario: Edit an existing rich pin**
  - **Given** a rich pin exists with title, body, and screenshot attachments
  - **When** the user chooses Edit from the pin row
  - **Then** Pin Studio loads the existing Tiptap document and attachments, saves changes atomically, and preserves the pin id, author, created timestamp, and done state.

- [x] **Scenario: Existing pins migrate lazily**
  - **Given** `.tachyon/pins.json` contains only legacy pins
  - **When** Tachyon starts and the sidebar lists pins
  - **Then** legacy pins render and MCP summary tools behave as before, without forcing a rewrite or creating detail files.

- [x] **Scenario: Agents can inspect rich pin detail without payload bloat**
  - **Given** a rich pin exists
  - **When** an agent calls `get_pin` for that pin id
  - **Then** the Bridge returns the summary, Tiptap JSON document, attachment metadata, workspace-relative attachment paths, and `available` flags, but not inline binary/base64 image content.

- [x] **Scenario: Agents inspect a legacy or text-only pin**
  - **Given** a legacy pin exists in `.tachyon/pins.json` with no rich detail file
  - **When** an agent calls `get_pin` for that pin id
  - **Then** the Bridge returns summary-only detail (`detail: false`, `doc: null`, `attachments: []`) rather than failing.

- [x] **Scenario: Unsupported or oversized image is rejected**
  - **Given** Pin Studio is open
  - **When** the user pastes/drops/imports an unsupported media type or a file above the configured limit
  - **Then** the editor shows a clear error and does not mutate the pin detail or blob store.

- [x] **Scenario: Delete a rich pin without deleting shared blobs**
  - **Given** two rich pins reference the same content-addressed image blob
  - **When** the user deletes one of those pins
  - **Then** the deleted pin's summary/detail are removed, the surviving pin still renders its attachment, and the shared blob is not removed.

- [x] **Scenario: Reopen instead of racing two Pin Studios**
  - **Given** Pin Studio is already open for pin `p-abc123`
  - **When** the user invokes Edit for `p-abc123` again
  - **Then** Tachyon reveals the existing Studio panel instead of opening a second editor for the same pin.

- [x] `PinStore` remains backward-compatible with legacy `pins.json` and keeps summary CRUD behavior intact.
- [x] A `PinAttachmentStore` or equivalent helper stores blobs content-addressed with temp+rename publication and path containment tests.
- [x] The generated `.gitignore`/init logic ignores `.tachyon/pins/` by default while keeping `.tachyon/pins.json` shareable.
- [x] Pin Studio links the shared `design-system.css` and is included in `esbuild.mjs` + `tsconfig.webview.json`.
- [x] Excalidraw is documented as v2/deferred and no Excalidraw dependency is introduced in v1.
- [x] Verification includes typecheck x2, engine-boundary, esbuild, full Vitest suite, and a green project UI test/harness that covers create/edit/paste/import. Preferred proof: a headless Pin Studio webview interaction harness that dispatches paste/drop events and verifies host messages, plus an extension-host integration check for command routing.

## Non-goals

- Reintroducing `.tachyon/notes.md`, `get_notes`, `set_notes`, or any free-form shared notes surface retired by spec 253.
- Returning screenshot bytes as base64 through `list_pins` or `get_pin`.
- Capturing the desktop/VS Code screen directly. V1 accepts screenshots via paste/drop/import.
- Excalidraw, reusable vector scenes, and full whiteboard UX in v1.
- Cloud sync, marketplace sharing, external issue tracker integration, or multi-user collaboration.
- A new general asset manager for all Tachyon surfaces.

## Open questions

- [x] **OQ1 — Exact Tiptap dependency set.** Resolved in § V1 behavior: use OSS, framework-neutral Tiptap packages only; no `@tiptap/react`, no Tiptap Pro UI components, no DragHandle in v1.
- [x] **OQ2 — Detail-file path and shareability.** Resolved: `.tachyon/pins/<pin-id>.json` and `.tachyon/pins/blobs/` are local/gitignored by default; `.tachyon/pins.json` remains the shareable checklist index.
- [x] **OQ3 — Attachment size limit.** Resolved: 10 MB hard limit per image, 50 MB soft warning for total local pin blobs per workspace.
- [x] **OQ4 — Agent-visible paths.** Resolved: `get_pin` returns workspace-relative paths plus `available` flags, never absolute paths and never binary payloads.
- [x] **OQ5 — UI proof mechanism.** Resolved: build a headless Pin Studio webview interaction harness for create/edit/paste/import and add extension-host command routing coverage where practical.

## Context / references

- Pin: `p-86fe67` in `/home/goat/Agent0/.tachyon/pins.json`.
- Spec 253 — retired notes; pins remain the structured checklist surface.
- Spec 239 — Activity log image blobs: content-addressed storage and one-time image side-channel are the precedent for "large image bytes outside the render/list model".
- Spec 252 — shared webview design system; Pin Studio must reuse it.
- Current code seams: `src/pins/PinStore.ts`, pin commands in `src/extension.ts`, Bridge pin tools in `src/bridge/tools.ts`, sidebar pin rendering in `src/webview/sidebar/App.tsx`, sidebar gatherer in `src/webview/SidebarPrototype.ts`, Activity image handling in `src/activity/logStore.ts` + `src/webview/ActivityPanel.ts`.
- Tiptap docs: FileHandler handles paste/drop files and Image renders images but does not upload them; Tachyon owns upload/blob storage.
  - https://tiptap.dev/docs/editor/extensions/functionality/filehandler
  - https://tiptap.dev/docs/editor/extensions/nodes/image
- VS Code webview docs: use CSP, `asWebviewUri`, and constrained local resources.
  - https://code.visualstudio.com/api/extension-guides/webview
- Excalidraw docs: Preact integration requires the Preact build path (`process.env.IS_PREACT`), supporting the v2 deferral.
  - https://docs.excalidraw.com/docs/%40excalidraw/excalidraw/integration

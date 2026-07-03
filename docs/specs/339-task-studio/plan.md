# 339 — task-studio — plan

_Drafted from `spec.md` (post-dueto, 22 findings folded) on 2026-07-03._

## Approach

Extraction-first, in strict order: make pin-studio's editor stack entity-neutral WITHOUT behavior change
(pin tests green at every commit), then build Task Studio on the extracted seams. Six layers:

1. **Extraction (no behavior change)** — pull entity-neutral modules out of pin-studio into
   `src/webview/rich-doc/` (or `shared/rich-doc/`): `document.ts` (toEditorDoc/EMPTY_DOC), `tiptap.ts`
   (editor schema/toolbar registry), `data-url.ts`, the Visuals panel component tree (currently inline in
   pin-studio/App.tsx ~500 lines), attachment VM types. Pin-studio keeps thin imports; a
   `StudioAdapter` interface (entityType, entityId, sidecar/attachment namespace, save semantics, message
   protocol) is introduced with `PinStudioAdapter` as the first implementation. The excalidraw bundle/entry
   stays SHARED (one `dist/webview/excalidraw.js`).
2. **Attachment namespace** — extract the blob/scene mechanics of `PinAttachmentStore` into a shared base
   (or parameterize by root dir + id validator); `TaskAttachmentStore` writes under
   `.tachyon/tasks/attachments/<task-id>/…` with the task-id parser as validator. Same
   ALLOWED_IMAGE_TYPES/limits/forbidden-scene-string rules (spec F16).
3. **`TaskDetailStore`** (`src/tasks/TaskDetailStore.ts`) — sidecar CRUD: `.tachyon/tasks/details/<id>.json`
   `{schemaVersion:1, taskId, doc, attachments, bodyHash, taskUpdatedAt}`; atomic write via temp+rename;
   lifecycle rules from the spec (missing=valid, malformed/newer=fail-closed read-only, dropped keeps,
   delete best-effort + GC of unreferenced task-scoped blobs); staged create-transaction helper.
4. **Serialization (pure, the risk center)** — `src/tasks/docMarkdown.ts`: Tiptap-JSON→markdown covering
   the toolbar node set (paragraph, heading, bold/italic/code marks, bullet/ordered/check lists,
   blockquote, code block, image→`![alt](attachment:<id>)` logical ref, sketch→`[sketch: <id>]` line) +
   truncation per spec (≤4000 total incl. stable marker, block/line boundary, no surrogate split, fence
   closing); `markdownDoc.ts`: body→doc import via the existing markdown-it token stream; `bodyHash`
   anchoring decisions + dirty-patch composition in `studioModel.ts`. No-op round-trip preservation is a
   TEST INVARIANT, not an implementation hope: if doc not dirty, Save never touches body.
5. **Panel + surface** — `TaskStudioPanelManager` (new-task singleton per workspace + per-task-id map,
   PinStudioPanel pattern) + `src/webview/task-studio/{App,main}.tsx` consuming the extracted modules via
   `TaskStudioAdapter`: title, fields row (kind/priority/deps/artifact_refs; assignee edit-mode-only with
   triage hint), rich editor + Visuals, freshness banner (scalar-only live updates), CAS conflict flow
   (reload-latest-reimport | export-local-draft), staged create Save.
6. **Board/detail wiring** — "+ Task"/shortcut/palette → Studio new-task mode; card context menu gains
   "Edit in Studio"; detail tab gains the button; inline quick-add REMOVED with spec-335 tests updated to
   the new flow; after Save the board reveals the new inbox card (or confirms under a hiding filter);
   task deletion path calls sidecar/attachment cleanup.

## Key decisions

- **Body-hash anchoring** (dueto F1/F2 cluster) — the sidecar is a derived companion of body, never an
  independent truth; external body edits win by reimport. Rejected conflict-metadata/merge (complexity,
  and v1 forbids doc merge anyway).
- **Extraction before feature** — rejected copy-then-diverge (double maintenance; dueto F8 named the
  coupling risk) and rejected big-bang rewrite of pin-studio (it is shipped and dogfooded; tests pin it).
- **New markdown serializer over Tiptap JSON** (no upstream lib) — the node set is small and closed; a
  hand-rolled serializer with exhaustive node-type tests beats adding a dependency that handles nodes we
  do not have. Images/sketches serialize as logical refs, NEVER filesystem paths (F9/F16).
- **Assignee disabled in create mode** — 325's mutability table (assignee only triaged/active); the probe
  proposed enabling it and was rebutted on this point.

## Files touched

- `src/webview/rich-doc/*` (new, extracted) + `src/webview/pin-studio/*` (thinned, no behavior change).
- `src/pins/PinAttachmentStore.ts` (extract shared base) + `src/tasks/TaskAttachmentStore.ts` (new).
- `src/tasks/TaskDetailStore.ts`, `src/tasks/docMarkdown.ts`, `src/tasks/markdownDoc.ts`,
  `src/tasks/studioModel.ts` (new, pure).
- `src/webview/TaskStudioPanel.ts`, `src/webview/task-studio/{App,main,messages}.tsx` + css (new).
- `src/webview/MissionControlPanel.ts` + `mission-control/App.tsx` (quick-add removal, context-menu entry),
  `src/webview/TaskDetailPanel.ts` (button), `src/extension.ts`, `package.json` (command), `esbuild.mjs`
  (task-studio entry; excalidraw entry shared).
- Tests: unit for every pure module; panel tests mirroring pinStudioPanel.test.ts; integration list from
  the spec; spec-335 quick-add tests updated.

## Risks & unknowns

- Tiptap→markdown fidelity is the deepest unknown — mitigate with exhaustive per-node tests + the no-op
  preservation invariant (which bypasses the serializer entirely for undirty docs).
- The 500-line pin-studio App.tsx extraction: do it mechanically (move component subtrees; no styling
  drift), verified by pin-studio tests + a pin-studio manual smoke in the human dogfood.
- Excalidraw lazy-load path exists for pins; confirm it composes when two studio types share one bundle.
- Body→doc import fidelity for exotic agent markdown: the invariant only guarantees no-op preservation;
  DIRTY saves accept documented lossy normalization (spec).

## Visual impact

A new full editor surface (Task Studio) + changes to the board header ("+ Task" now opens it) and card
context menu. Human dogfood must include a pin-studio regression smoke (extraction touched its guts).
Evidence: agent-screen captures of the Studio (create mode, edit mode with visuals, freshness banner).

## Sources consulted

- docs/specs/339-task-studio/spec.md (post-dueto) + notes.md disposition log (probe-8f6c9a57).
- src/webview/pin-studio/* + PinStudioPanel.ts + src/pins/PinAttachmentStore.ts (extraction sources).
- src/tasks/* (325 entity + 335 board modules), esbuild.mjs entry patterns.
- Specs 325/335 (entity contract, board criteria being amended).

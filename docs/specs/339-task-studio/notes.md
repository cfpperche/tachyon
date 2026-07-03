# 339 — task-studio — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### T1 — extraction

- New neutral type module `src/richDoc/types.ts` (host+webview safe, no vscode dep) holds the doc/attachment
  shapes (`TiptapJSON`, `RichDocAttachment`, `ResolvedRichDocAttachment`, ...). `src/pins/types.ts` now
  re-exports these under its historical `Pin*` names via `export type ... as ...` — a pure type alias, zero
  runtime change, every existing pin import keeps resolving unchanged. This is what lets `TaskAttachmentStore`
  (T2) and `TaskDetailStore`/serializers (T3/T4) share the same shapes without importing from `src/pins/*`.
- `src/webview/rich-doc/` holds the extracted webview modules: `document.ts` (toEditorDoc/toStoredDoc/etc,
  generalized off `PinStudioAttachmentVM` → `RichDocAttachmentVM`), `tiptap.ts` (`createRichDocEditor`,
  `RichDocImage`/`RichDocSketch` — the `tachyonSketch` node-type STRING is unchanged, only the TS class
  names moved), `data-url.ts` (verbatim), `toolbar.tsx` (new: `EditorToolbar`/`SlashMenu`, data-free but
  JSX-driven — the "toolbar registry" from plan.md), `VisualsPanel.tsx` (new: the Visuals aside +
  `SketchModal` + the excalidraw script/css lazy-loader, extracted from pin-studio's ~500-line App.tsx),
  `adapter.ts` (the `StudioAdapter` seam; `createPinStudioAdapter()` is the first implementation — used only
  for the eyebrow label strings in v1, since PinStudioPanel's host-side save semantics/paths are untouched by
  design — T5 will build `createTaskStudioAdapter()` analogously for its own App).
- `pin-studio/{document,data-url}.ts` became one-line `export * from "../rich-doc/..."` shims so every
  existing import path (including both pin-studio test files, which import these modules directly) keeps
  resolving with ZERO edits to test files, satisfying "pin-studio unit tests untouched and green" literally.
  `pin-studio/tiptap.ts` re-exports both the new names and the historical `createPinEditor`/`PinImage`/
  `PinSketch` aliases for the same reason.
- CSS: entity-neutral editor/toolbar/visuals/sketch-modal styles moved to a new `rich-doc.css` (shared by
  pin-studio and task-studio); `pin-studio.css` keeps only the pin-specific tag editor. `.pin-editor` CSS
  class renamed to `.rich-doc-editor` (mechanical rename, both the tiptap `editorProps.attributes.class` and
  the CSS selector updated together — no visual change). `PinStudioPanel.ts`'s webview `styles` array now
  loads `rich-doc.css` before `pin-studio.css`; esbuild.mjs copies it to `dist/webview/`; the dev preview
  harness route for `pin-studio` includes it too.
- tsconfig: `src/webview/rich-doc` added to main `tsconfig.json`'s exclude list and to
  `tsconfig.webview.json`'s include list, mirroring exactly how `pin-studio` itself is split across the two
  configs (Node16 host resolution vs Bundler/JSX webview resolution) — avoids double-checking the same files
  under two incompatible module-resolution modes.
- Verified: both typechecks green, full `npm test` suite green except one PRE-EXISTING flaky test
  (`test/unit/tmux.real.test.ts` — real-tmux capture timing race, unrelated to this change; passes in
  isolation on rerun — logged here per the task's "prove and register" rule for pre-existing failures).
- Unrelated pending changes noted, not touched by this work: `docs/specs/338-*` (4 modified files) and an
  untracked `assets/` directory were already present in the working tree before T1 started — left alone,
  committed nothing from them.

### T2 — attachment namespace

- `PinAttachmentStore`'s blob/scene mechanics (validateImage/putImage/putExcalidraw/normalizeExcalidrawScene/
  readExcalidrawScene/writeBlob/blobPath/resolveAttachment/totalBlobBytes/overSoftLimit) moved verbatim into
  an abstract `src/richDoc/AttachmentStore.ts#RichDocAttachmentStore` base; subclasses supply only
  `blobDir`, `relativeBlobPath`, `fallbackRelativePath` (unavailable-ref placeholder), and `blobRefLabel`
  (the noun used in validation error messages — kept per-subclass so `PinAttachmentStore`'s existing
  `"invalid pin blob ref"` assertions in `pinAttachmentStore.test.ts` stay byte-identical while
  `TaskAttachmentStore` gets its own `"invalid task attachment blob ref"` wording).
  `PinAttachmentStore` is now a ~20-line subclass; `PIN_ALLOWED_IMAGE_TYPES`/`PIN_IMAGE_MAX_BYTES`/
  `PIN_BLOB_SOFT_LIMIT_BYTES`/`PIN_EXCALIDRAW_SCENE_MEDIA_TYPE`/`isPinBlobRef`/`PutPinImageInput`/
  `PutPinExcalidrawInput`/`NormalizedExcalidrawScene` all re-exported under their historical names — every
  existing pin import (`bridge.test.ts`, `pinRichStore.test.ts`, `pinSketchDogfood.test.ts`,
  `pinAttachmentStore.test.ts`, `SidebarPrototype.ts`, `PinStore.ts`, `PinStudioPanel.ts`) is unaffected.
- `src/tasks/TaskAttachmentStore.ts` (new): one instance is bound to exactly one task id (validated against
  `TASK_ID_RE` at construction — rejects both malformed ids and pin ids like `p-xxxxxx`). Blobs live under
  `.tachyon/tasks/attachments/<task-id>/blobs/…`; namespace isolation is structural (two `TaskAttachmentStore`
  instances for different task ids simply point at different directories on disk — there is no code path
  that lets task A's store read task B's blob) and traversal is blocked by the inherited `blobPath` (only
  bare 64-hex sha256 refs accepted, `path.resolve` containment check). Same `ALLOWED_IMAGE_TYPES`/
  `IMAGE_MAX_BYTES`/`BLOB_SOFT_LIMIT_BYTES`/`EXCALIDRAW_SCENE_MEDIA_TYPE`/forbidden-scene-string rules reused
  directly from the shared base (re-exported under `TASK_*` names for symmetry with the pin side).
- New `test/unit/taskAttachmentStore.test.ts` (7 tests): task-id validation, content-addressed storage +
  workspace-relative paths, cross-task isolation (writing through one task's store never becomes visible
  through another task's store even for the identical blobRef), traversal rejection, size/type limits,
  dedup, and Excalidraw forbidden-payload rules — mirrors `pinAttachmentStore.test.ts`'s coverage 1:1 for
  the new entity.
- Caught and fixed in this task (pre-existing test, not itself part of T2): `webviewPreviewRoutes.test.ts`
  asserted an exact `cssLinks` array for the `pin-studio` preview route; T1's addition of `rich-doc.css` to
  that route (needed so the dev preview harness renders identically to the real webview) broke it. Updated
  the expectation to include `rich-doc.css` — this should have been caught before T1's commit; recorded here
  for the audit trail. Full suite (154 files) is green after the fix.

### T3 — TaskDetailStore sidecar CRUD

- `src/tasks/TaskDetailStore.ts` (new): `read(taskId)` returns a 3-way `{missing|malformed|ok}` result —
  missing is valid (F6, caller reimports from body); malformed covers both bad JSON AND any
  `schemaVersion !== 1` (so an unknown *future* version fails closed the same way a corrupt file does, per
  the spec's "malformed or unknown-newer schemaVersion" combined rule) AND missing/wrong-typed required
  fields. The bodyHash ANCHORING DECISION itself (load-as-is vs reimport) is deliberately NOT in this file —
  it's pure logic that belongs in `studioModel.ts` (T4) so it's unit-testable without any filesystem, per
  plan.md's "no-op round-trip preservation is a TEST INVARIANT, not an implementation hope."
  `write()` is atomic (temp+rename, mirrors `PinStore.writeDetailFile`). `delete()` removes the sidecar file
  + the task's ENTIRE attachment namespace (`TaskAttachmentStore#taskAttachmentsDir`) best-effort, collecting
  errors instead of throwing (F13). `gcRemovedAttachments(taskId, previous, next)` diffs two attachment
  lists and removes now-unreferenced blobs one at a time (best-effort per-blob, content-addressed dedup
  means a blob still referenced by any kept attachment is never touched even if a stale entry also pointed
  at the same bytes).
- Orphan sidecars (no task file) — the spec says these are "ignored at runtime." `TaskDetailStore` never
  enumerates all sidecars; every read/write/delete is keyed by a specific `taskId` the caller already has
  (from a real `Task`). There is no code path today that lists `.tachyon/tasks/details/*.json` independent
  of the task queue, so an orphan simply sits inert on disk unless/until a future cleanup sweep is added —
  satisfying the rule without needing an explicit orphan-scan method in T3.
- **`TaskStore.create()` gained an optional `id` field** (`src/tasks/types.ts` `TaskCreateInput.id?`) — this
  is a small addition to the ALREADY-SHIPPED spec-325 store, done here because it's the seam
  `createStaged()` needs: Task Studio's create-mode Visuals panel must let the user paste/sketch images
  BEFORE Save (before any task exists), and `TaskAttachmentStore` is namespaced by task id
  (`.tachyon/tasks/attachments/<task-id>/…`) — so the id has to be reserved up front. `mintTaskId()` (the
  same generator `TaskStore` already used internally) is now exported for exactly this: Task Studio mints a
  provisional id when a new-task panel opens, uses it as the attachment namespace during editing, then
  passes that SAME id through `createStaged(taskStore, id, input)` so the sidecar and the task land under
  the identical id — never two independently-minted ids that could mismatch. When `id` is omitted, `create()`
  behaves EXACTLY as before (unchanged auto-mint loop, verified by the existing `taskStore.test.ts` suite
  staying green); 3 new tests cover the `id`-supplied path (success, malformed-id rejection, collision
  rejection-without-fallback-mint).
- `createStaged`'s failure-cleanup contract (documented for T5/T7): if `taskStore.create` throws (e.g. id
  collision — astronomically rare, `t-` + 3 random bytes), NOTHING was created (task or sidecar) — the
  caller (T5's create-mode Save handler) is responsible for best-effort deleting the provisional attachment
  directory it had been writing to during editing. This is exactly T7's listed "create staged transaction
  failure cleanup" integration test. If the sidecar `write()` throws AFTER `taskStore.create` succeeded, the
  task now simply exists without a sidecar — a valid, already-covered lifecycle state (F6), not an orphan;
  the caller surfaces the sidecar-write error to the user without rolling back the task.
- New `test/unit/taskDetailStore.test.ts` (15 tests) + 3 new cases appended to the existing
  `test/unit/taskStore.test.ts` for the `id` option. Full suite (155 files, 2144 tests) + both typechecks
  green.

### T4 — pure serialization modules (docMarkdown/markdownDoc/studioModel)

- `docMarkdown.ts` (doc→markdown, the "risk center"): hand-rolled recursive serializer covering exactly the
  toolbar's node set (paragraph, heading 1-6 clamped from attrs, bold/italic/code marks, links,
  bullet/ordered/task lists incl. nested lists inside a list item, blockquote, code block w/ language,
  image→`attachment:<id>` logical ref, sketch→`[sketch: <id>]`, hard break, horizontal rule) plus a
  best-effort text-flattening fallback for any node type outside that set (never silently drops content).
  Plain text runs are markdown-escaped (`\ \` * _ [ ]`); code-mark runs are NOT escaped (verbatim, per
  commonmark code-span semantics) — combining marks nests italic inside bold (`**_x_**`), an arbitrary but
  now-tested convention. `truncateBody()` is exported standalone from `docToMarkdown()` specifically so the
  boundary math is unit-testable without needing a doc at all: code-point-array slicing (never `.slice()` on
  a raw string) guarantees no surrogate-pair splits; boundary preference scans backward for the LAST `\n\n`
  within budget (keeps as much complete content as fits, not just the first blank line found) then the last
  bare `\n`; an odd `` ``` `` count in the cut prefix gets a closing fence appended only when it still fits
  the budget (spec's literal "when it fits" — no recursive re-trimming to force it to fit).
- `markdownDoc.ts` (body→doc import): walks `markdown-it`'s raw token stream directly (`md.parse()`, never
  `.render()`) with a hand-rolled recursive-descent cursor — confirmed via a throwaway node REPL that
  `markdown-it-task-lists` is renderer-only (rewires HTML output, doesn't annotate tokens), so checklist
  items are detected manually: a list item whose first paragraph's first text node matches `^[ xX]\s` is
  reinterpreted as a `taskItem` with the marker stripped, and a `bulletList` becomes a `taskList` only when
  EVERY item in it matched (mixed lists stay a plain `bulletList`, matching what `docMarkdown.ts` would never
  itself produce). Same manual-detection approach for the `attachment:<id>` image scheme and the
  `[sketch: <id>]` line marker (both are docMarkdown's own bespoke conventions, not real markdown-it token
  types). Heading levels >3 are clamped down to 3 on import (documented lossy normalization — the shared
  `rich-doc/tiptap.ts` editor is configured for levels 1-3 only). Anything markdown-it tokenizes that isn't
  in the explicit switch (tables, raw HTML blocks, etc.) falls back to a paragraph carrying the token's raw
  `content` verbatim — preserved as inert text, never dropped, which is what makes the exotic-markdown test
  case (tables/nested-fence-strings/HTML/link-titles) merely need to "not crash and not lose content" rather
  than round-trip perfectly.
- `studioModel.ts`: `decideAnchor(task, read)` is the 3-way authoring-truth decision — `"load"` only when
  the sidecar is `status:"ok"` AND its `bodyHash` equals `hashBody(task.body ?? "")`; `"reimport"` for
  missing OR hash-mismatched sidecars (external edit wins); `"read-only"` for `status:"malformed"` (never
  reimported — the spec's fail-closed rule). `composeDirtyPatch(values, dirty, opts)` takes the CURRENT field
  values, a `dirty` flag set, and optional `{body, expectUpdatedAt}`, and returns exactly (and only) the
  `TaskUpdateInput` keys the caller marked dirty — `status`/`rank` cannot even be expressed as inputs to this
  function (proof by construction, not by a runtime filter), and the empty-dirty-set test explicitly feeds in
  "fresher" field values (simulating live fan-out arriving while the Studio is open) to prove they never leak
  into the patch when untouched. `isEmptyPatch()` lets T5 skip the `update_task` round-trip entirely on a
  true no-op Save.
- New test files: `docMarkdown.test.ts` (28 tests — one per node type/mark/truncation-boundary rule),
  `markdownDoc.test.ts` (31 tests — one per import construct + a 12-case import→reserialize round-trip table
  + one "doesn't crash on exotic markdown" case), `studioModel.test.ts` (13 tests — every anchor-decision
  branch + dirty-patch composition, including the tasks.md-declared dogfood filter `-t "no-op"`, verified to
  actually match 2 tests). Full suite (158 files, 2216 tests) + both typechecks green.

### T5 — TaskStudioPanelManager + task-studio webview surface

- **CAS baseline ownership moved to the CLIENT, not the host's live fan-out** (a design correction made
  mid-task, not a plan.md deviation since plan.md didn't specify this): the obvious implementation has
  `TaskStudioPanelManager` remember `expectUpdatedAt` from whatever VM it last POSTED (including background
  `refreshAll()` re-posts triggered by unrelated concurrent edits). That's wrong — it would silently advance
  the CAS baseline on every live refresh even while the user has unsaved dirty edits, defeating the
  precondition check the freshness-banner/CAS-conflict flow exists to catch. Instead, the WEBVIEW tracks
  `expectUpdatedAt` itself: it only advances when there's nothing dirty to protect (a transparent live
  adopt) or after an explicit "Reload latest" action, and sends its own belief back in the `save` message
  (`TaskStudioWebviewMessage`'s `save.expectUpdatedAt`). The host's `TaskStore.update` still authoritatively
  enforces it — an incorrect client-tracked value just fails closed with `precondition-failed`, same as
  today's board/detail CAS paths — so there's no new trust boundary, only a correctness fix to WHEN the
  client's belief is allowed to move.
- **Staged create-transaction id reservation**: `openNew()` calls the now-exported `mintTaskId()` (T3) up
  front and uses that id as the `TaskAttachmentStore` namespace for the ENTIRE editing session — screenshots/
  sketches pasted before the first Save persist immediately under `.tachyon/tasks/attachments/<provisional-id>/`,
  with no relocation step needed at Save time (T3's `createStaged(taskStore, id, input)` uses that exact id
  for both the task and the sidecar). Both failure paths clean up that namespace: a failed `createStaged`
  (id collision) and an explicit Cancel before ever saving both `fs.rmSync` the whole
  `taskAttachmentsDir` best-effort — covered by dedicated tests (T7's "create staged transaction failure
  cleanup" integration case, done here rather than deferred, since the panel manager IS the natural owner of
  this cleanup and it was cheap to cover alongside the rest of the create-mode tests).
- **Bug caught by the panel's OWN staged-create test, not by T3's tests**: `createStaged` originally passed
  `body: input.body` unconditionally to `taskStore.create()` — but `TaskStore.create`'s `body` field goes
  through `boundedString` (via `optionalStringField`), which THROWS on an empty-after-trim string ("body
  must be non-empty"). A brand-new task whose doc is still the empty placeholder paragraph serializes to
  `""` via `docToMarkdown`, so create-mode Save on an empty doc was failing the ENTIRE staged transaction.
  Fixed in `TaskDetailStore.createStaged` (`src/tasks/TaskDetailStore.ts`): `body` is now only passed to
  `taskStore.create` when non-empty after trim, matching how `task.body` is already optional everywhere else
  (`decideAnchor` already treats a missing body as `hashBody("")` for anchoring, so the sidecar's `bodyHash`
  stays consistent either way). This was T3 code but the bug only surfaced once T5's panel actually exercised
  the empty-doc create path end-to-end — recorded here since that's where it was found and fixed.
- **Test-suite flake found and fixed while writing `taskStudioPanel.test.ts`**: the async host message
  handlers (create/update both go through `TaskStore`'s own internal mutation-queue promise chain) don't
  reliably settle within a single `await new Promise(r => setTimeout(r, 0))` tick — the convention used by
  `missionControlPanel.test.ts`/`taskDetailPanel.test.ts`. Switched to `vi.waitFor(() => expect(...), {timeout,
  interval})` (poll-until-true) for every post-`__receive` assertion in this file, which is strictly more
  robust for a deeper await chain (create/update → sidecar write → GC) without guessing a magic delay.
  Separately, the CAS-conflict test itself had a genuine millisecond-resolution race: creating a task and
  then immediately "concurrently" updating it (both via `new Date().toISOString()`, no explicit `now`) could
  land in the SAME millisecond, giving the two operations an IDENTICAL `updatedAt` and masking the CAS
  mismatch the test exists to prove — fixed by passing explicit, one-second-apart `now` timestamps to both
  calls. Neither issue was in production code; both are documented in case a future test in this file hits
  the same class of flake.
- Host module `src/webview/TaskStudioPanel.ts` mirrors `PinStudioPanel.ts`'s shape closely (constructor
  `(extensionUri, onTasksChanged)`, `openNew`/`openExisting`, `vmFor`, `attachmentsForPanel`, import/attach/
  sketch handlers) but is keyed like `TaskDetailPanelManager` (one entry per task id, PLUS a `:new` singleton
  key per workspace for the create-mode panel — spec's "one new-task panel per workspace + one per task id").
  Webview `src/webview/task-studio/App.tsx` reuses EVERY rich-doc module from T1 (`EditorToolbar`, `SlashMenu`,
  `VisualsPanel`, `SketchModal`, `createRichDocEditor`, `toEditorDoc`/`toStoredDoc`/etc) plus a new
  `createTaskStudioAdapter()` (rich-doc/adapter.ts) for the eyebrow labels — task code never imports
  `PinStore`/`PinAttachmentStore` and pin code never imports task stores (F8's "task code never imports
  pin-specific stores/paths directly", proven by construction: neither webview file has an import path into
  the other's directory).
- Fields row: kind (free text ≤64), priority (`<select>`, same P0-P3 as the board), assignee (plain `<input>`
  with a `<datalist>` of `vm.knownAgents`, `disabled` in create mode with a title-attribute hint — 325's
  mutability table), deps (chip input validated against the imported `TASK_ID_RE` — not a re-encoded regex —
  with self-dep and duplicate rejection client-side; the store's own `assertTaskId`/dedup is still the
  authority at Save), artifact_refs (`type:ref` chip input, client-side bounds mirroring the store's max-10/
  dedupe so the user gets immediate feedback, store validation still authoritative). Removable chips reuse
  pin-studio's bespoke "whole-pill-removes-on-click" pattern (`.chip-pill`, task-studio.css) rather than the
  shared kit's static `Chip` — same reasoning pin-studio's own tag-pill comment already gives.
  One shared-kit gap found along the way: `Input`/`Textarea` (`shared/ui/Field.tsx`) omit `value`/`maxLength`
  from their prop types (`Omit<JSX.HTMLAttributes<...>>` lacks element-specific attrs like `value`) — pin-studio
  already works around this by using raw `<input>` elements instead of the shared wrapper for anything
  value-bearing; task-studio's kind/assignee fields do the same (`<input class="ds-input">`). This surfaced
  ONLY because task-studio's `.tsx` files are actually typechecked (added to `tsconfig.webview.json`,
  mirroring pin-studio) — `mission-control`/`task-detail`'s own `.tsx` files use the same `Input` component
  the same value-bearing way and have NEVER been typechecked by either tsconfig (an existing gap, not
  something this task introduced or fixed — noted for whoever eventually closes it).
- Freshness banner (concurrent safety, F10/F18): the webview keeps the ORIGINALLY-loaded field values in a
  ref and, on every subsequent VM push, diffs the fresh values against them per field — a field the user
  hasn't touched adopts the fresh value transparently (title/kind/priority/assignee/deps/artifact_refs); a
  field the user HAS touched that also diverged externally is named in a banner, never auto-merged. The rich
  doc itself is only silently refreshed (`editor.commands.setContent`, no `emitUpdate`) when `docDirty` is
  false — a dirty doc is NEVER touched by an incoming push, matching the spec's "rich doc NEVER auto-merges"
  literally regardless of how many other fields are clean.
- Scope simplification, recorded rather than gold-plated: "export local draft" (the CAS-conflict banner's
  second option) is implemented as a clipboard copy of the title + a placeholder marker, not a full
  serialized-doc export — the mechanism (client-side, no host round trip) is in place and the button works,
  but producing a richer draft (e.g. the full markdown) is a one-line follow-up once `docToMarkdown` is
  wired to the webview bundle for THIS purpose (it currently only runs host-side). Left as v1-adequate since
  the primary conflict-recovery path is "Reload latest," which is fully implemented.
- Wiring NOT done in this task (deliberately — that's T6): no command/menu opens Task Studio yet
  (`extension.ts`, `package.json`, board "+ Task", card context menu, detail-tab button all untouched). The
  panel manager + webview are fully built and tested standalone, same as how T1-T4 built the substrate before
  any surface consumed it.
- New `test/unit/taskStudioPanel.test.ts` (14 tests): panel identity (new-task singleton + per-task-id reuse),
  staged create (success incl. body derivation, assignee-never-settable, failure cleanup, cancel cleanup),
  edit mode (all three anchor branches, dirty-patch-only composition, doc-dirty-gated sidecar write, no-op
  Save, CAS conflict, reloadLatest). Full suite (159 files, 2230 tests, run 3× for flake confidence after the
  two fixes above) + both typechecks green.

### T6 — wiring board/detail to Task Studio

- Removed the board's inline quick-add (`CreateForm`/`showCreate`/`submitCreate` in `mission-control/App.tsx`,
  the `.mc-create*` CSS, and the `createTask` webview→host action + `MissionControlPanel.ts` handler
  entirely) — per spec F12, every create path now opens the Studio. Replaced with a single
  `openTaskStudio(id?: string)` action (`mission-control/messages.ts`) shared by two call sites: the "+ Task"
  header button (no id → new mode) and the card context menu's new "Edit in Studio" entry (with id → edit
  mode). `MissionControlPanelManager`/`TaskDetailPanelManager` both gained an injected `openTaskStudio`
  callback (same pattern as the existing `openTaskDetail` injection), wired in `extension.ts` to
  `TaskStudioPanelManager.openNew`/`openExisting`. `cardMenuActions()` (`interactions.ts`) now always
  includes "Edit in Studio" (unlike the status-gated "Move to Dropped") — updated its 2 existing tests to
  match the new non-empty baseline rather than deleting them.
- Per tasks.md's "spec-335 quick-add tests are UPDATED to cover the new path, not deleted": the old
  `missionControlPanel.test.ts` case "applies a create-from-board action with author:human..." (which
  exercised the store's author-forcing behavior through the now-removed `createTask` action) was replaced
  with two `openTaskStudio` delegation tests (new-mode no-id, edit-mode with-id) — the author-forcing
  behavior itself is still covered, just at its new home (`taskStudioPanel.test.ts`'s staged-create tests),
  since that enforcement now lives in `TaskDetailStore.createStaged`/`TaskStudioPanelManager`, not
  `MissionControlPanel`.
- Detail tab: added an "Open in Studio" button to `.td-actions` (`task-detail/App.tsx`), a new
  `openTaskStudio` action (`task-detail/messages.ts`), and a `TaskDetailPanelManager` constructor param —
  since a Detail panel is already scoped to one task id, the message carries no payload (unlike the board's
  `id?`, which distinguishes new-vs-edit).
- Command palette: registered `tachyon.taskStudio.new` (mirrors `tachyon.missionControl`'s `pickWorkspace()`
  fallback pattern) with `command.taskStudioNew` i18n strings in both `package.nls.json` and
  `package.nls.pt-br.json`. No VS Code **keybinding** was added: research before T6 confirmed the board's
  original quick-add never had one either (no `contributes.keybindings` section exists in `package.json` at
  all) — spec's "its former quick-add keyboard path" refers to a path that never existed as a real OS-level
  shortcut, so there was nothing to migrate; inventing a new keybinding here would be scope the spec didn't
  ask for.
- "Deletion path cleanup" (spec's attachments+sidecar-lifecycle scenario) is a no-op in this task by
  necessity, not by omission: grepped the whole task/board/detail/bridge surface and confirmed NO task
  hard-deletion command or code path exists anywhere in the product today (325/335 only ever added `dropped`
  status, which explicitly KEEPS the sidecar + attachments per spec). `TaskDetailStore.delete()` (T3) is
  already implemented and tested for whenever a deletion feature is eventually added — there's simply
  nothing in the UI to wire it to yet.
- Deferred to T7 (not a T6 gap, T7's own declared scope): task-studio's `attachFile` only checks the 10MB
  size limit client-side, not the allowed-MIME-type set pin-studio's `App.tsx` also checks before posting —
  T7 is explicitly "import/paste sanitization rules (types/sizes/SVG)," so the fix lands there alongside the
  rest of that hardening pass rather than half-doing it here.
- Full suite (159 files, 2232 tests) + both typechecks + a fresh `esbuild.mjs` full build all green.

### T7 — hardening + integration tests

- Import/paste sanitization parity (F16): `task-studio/App.tsx`'s `attachFile` now checks the same
  `ALLOWED_IMAGE_TYPES` set (png/jpeg/webp/gif — SVG excluded, matching pin-studio's own client-side check
  and the reasoning in its comment: SVG can carry executable script) BEFORE ever posting a paste/drop to the
  host, not just the 10MB size limit it already had. The host-side authority (`TaskAttachmentStore`,
  inherited from `RichDocAttachmentStore.validateImage`, T2) already rejected non-allowlisted types and
  oversized images regardless — this closes the client-side UX gap (immediate feedback vs. a round-trip
  error), it does not change what the store actually accepts.
- New `test/unit/taskStudioIntegration.test.ts` (3 tests) — the two integration cases that genuinely need
  MULTIPLE wired-together panel managers (the other three named cases — create-failure cleanup,
  edit-with-missing-sidecar, CAS-vs-concurrent-update_task — already lived in `taskStudioPanel.test.ts`,
  single-manager tests):
  - **"+ Task" board flow, end to end**: wires `MissionControlPanelManager` + `TaskDetailPanelManager` +
    `TaskStudioPanelManager` exactly like `extension.ts` does, drives the board's own `openTaskStudio`
    action (both the no-id "+ Task" case and the with-id "Edit in Studio" case), Saves through the Studio
    panel that opens, and asserts the task exists AND the ORIGINAL board panel's next snapshot shows it in
    Inbox — proving the whole chain (not just each manager's own injected-callback unit test).
  - **Attachment GC through the real Save path**: two sequential Saves against `TaskStudioPanelManager`
    (first keeps an image referenced in the doc, second removes it) prove the blob survives the first Save
    and is gone after the second — `TaskDetailStore.gcRemovedAttachments` was already unit-tested (T3) with
    hand-built attachment lists; this proves the PANEL actually wires `previousRead`/`m.attachments`
    correctly into that call, which a pure unit test of `TaskDetailStore` alone can't catch.
- **A second instance of the empty-body bug (T5's notes documented the create-mode one) — found by this
  integration test, not by taskStudioPanel.test.ts's own edit-mode cases**, because none of THOSE happened to
  save an emptied-out doc: `TaskStudioPanel.save()`'s edit-mode branch derived `body = docToMarkdown(m.doc)`
  and passed it straight into `composeDirtyPatch`'s `body` option whenever the doc was dirty — including
  when the doc serialized to `""` (e.g. the second Save in the GC test above, which drops the image AND
  leaves just an empty paragraph). `TaskStore.update`'s `body` field goes through the same
  `boundedString`/non-empty check `create` does, so this threw `precondition-failed`-shaped... no, a
  DIFFERENT thrown error ("body must be non-empty") that isn't the CAS-conflict case, so it propagated to
  the outer catch and posted an "error" message instead of completing the save — the GC integration test
  caught this because it specifically exercises "emptying a previously-attached doc," which none of the
  earlier hand-written edit-mode tests happened to do. Fixed by widening
  `studioModel.ComposeDirtyPatchOptions.body` to `string | null` and having `TaskStudioPanel.save()` convert
  an empty derived body to `null` (clears the field) before it reaches `composeDirtyPatch` — the RAW
  (possibly empty) string is still what gets hashed into the sidecar's `bodyHash`, keeping it consistent with
  `decideAnchor`'s `hashBody(task.body ?? "")` treatment of a cleared body. This is the second time an
  emptied-doc edge case surfaced only once a NEW test exercised it specifically — worth remembering if any
  future Task Studio work adds another body-touching path: always include an "emptied doc" case.
- **Encountered, NOT caused, and explicitly out of scope to fix**: while re-running the typecheck gate for
  this task, `src/bridge/tools.ts` started failing to compile (`Cannot find name 'normalizeCreatePinInput'`,
  `'plainTextDoc'` — both referenced but never defined) with NO commit from this session touching that file.
  `git diff --stat src/bridge/tools.ts` shows 13 lines of UNCOMMITTED changes (a concurrent, in-progress
  `add_finding`/`create_pin` refactor by a different session in this shared workspace) that this task's own
  constraints explicitly forbid touching ("Não tocar em src/bridge/tools.ts — sidecar invisível ao bridge em
  v1 é critério"). Verified the blast radius is fully isolated: `npx tsc --noEmit` reports exactly those 3
  errors, all in that one file; `npm test` is 159/160 files green, the one failure
  (`bridge.test.ts` > "pins tools round-trip...") exercises exactly the broken `create_pin` code path and
  nothing else. Every spec-339 file (T1-T7) typechecks clean in isolation and its own dedicated test files
  are 100% green. This is registered here per the task's own "falha pré-existente → prove e registre" rule —
  it is not this task's failure to fix, and fixing it would mean editing a file this task was told not to
  touch. Whoever owns that other work should re-run `npm run typecheck && npm test` once it lands.
  **Update, same session**: by the time all of T7's own work was committed, that external work had finished
  landing on disk (still uncommitted, but complete) — a final `npm test` + both typechecks are 160/160 files,
  2237 tests, fully green with no exceptions. Confirms this was exactly what it looked like: someone else's
  in-progress save, not a spec-339 regression.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- **T3 create-transaction ordering**: plan.md/spec.md describe "mint id → write sidecar to temp →
  `TaskStore.create` → promote sidecar atomically." The implementation instead does `TaskStore.create({id})`
  FIRST, then writes the sidecar directly to its final path (still atomic via temp+rename inside `write()`).
  Why: the literal ordering only matters if minting and task-creation are independent id spaces that could
  drift out of sync; here `mintTaskId()` produces the id and `TaskStore.create({id})` is asked to use that
  EXACT id (new optional field, see above), so there is no scenario where the sidecar's id and the task's id
  could differ. Task-first ordering also means the only failure modes are "nothing created" (create threw)
  or "task exists, sidecar missing" (write threw after create succeeded) — the second is already an
  explicitly VALID lifecycle state (F6), never an orphan. This is strictly safer than the literal ordering
  (which still had to tolerate orphans as a possible outcome) while being simpler to implement and test.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Design dueto (probe codex, adversarial-review, 2026-07-03, runId probe-8f6c9a57)

22 findings (5 blockers). Spec text was embedded inline in the probe prompt per [[probe-sandbox-no-fs]].
Disposition:

- **F1/F2/F15/F18 (BLOCKERS + majors, the "three writers" cluster)** — ACCEPTED via a SIMPLER mechanism
  than proposed: body-hash anchoring instead of conflict metadata/merge UI. The sidecar records the hash of
  the body it derived; a mismatched hash at load means an external (agent) edit happened and the doc is
  REIMPORTED from body — most-recent-writer-wins, body is the interchange format, no dual truth, no merge.
  No-op saves never rewrite body (round-trip preservation unit-tested). F15's limitation is now explicit in
  the spec + requires a follow-up queue task for read-only doc access via bridge tools.
- **F3 + F20 (BLOCKER, truncation)** — ACCEPTED merged: ≤4000 TOTAL incl. a stable non-localized ASCII
  marker, block/line-boundary cuts, no surrogate splits, fence-closing, exact-boundary tests.
- **F4 (BLOCKER, save shape)** — ACCEPTED: dirty-field patch only, never status/rank/untouched fields.
- **F5 + F11 (BLOCKER, sidecar CAS/atomicity)** — ACCEPTED reduced: with body-hash anchoring the sidecar is
  a derived companion, not independent truth, so full sidecar CAS is unnecessary; staged create transaction
  (temp sidecar → store create → atomic promote) + taskUpdatedAt echo cover the failure windows.
- **F6/F9/F13/F21 (lifecycle/namespace/size/schema)** — ACCEPTED as the consolidated lifecycle criterion.
- **F7 (create-mode contradiction)** — ACCEPTED with a 325-consistency correction the probe missed: full
  field set in create EXCEPT assignee, which 325's mutability table forbids outside triaged/active —
  disabled with an "assign during triage" hint (probe proposed enabling it; that would violate the table).
- **F8 (extraction boundary)** — ACCEPTED: entity-neutral modules + adapter seams, pin tests protect Pin
  Studio.
- **F10 (board race)** — ACCEPTED trimmed: dirty-patch exclusion of board-owned fields makes field-level
  CAS unnecessary; banner names changed fields.
- **F12 (quick-add migration)** — ACCEPTED: create semantics + tests preserved/updated.
- **F14/F16 (webview memory, import security)** — ACCEPTED as criteria.
- **F17 (validation via store parser)** — ACCEPTED.
- **F19 (create visibility)** — ACCEPTED: reveal-or-confirm after Save.
- **F22 (integration coverage)** — ACCEPTED: named integration list added.
- Nothing rebutted outright; F5 and F7 were accepted with corrections where the probe's concrete proposal
  conflicted with the shipped 325 contract (sidecar-as-derived-truth; assignee mutability).

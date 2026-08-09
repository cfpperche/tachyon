# 339 — task-studio

_Created 2026-07-03._

**Status:** shipped
**Closure:** shipped 2026-07-03 — T1-T7 (extraction, TaskAttachmentStore, sidecar with body-hash anchoring,
serializer with no-op preservation, panel+surface, wiring, hardening) by ad-hoc Sonnet taskStudio, then two
human dogfood rounds + polish waves (tsFixes, uiFixes, uiPolish): visuals thumbnails/annotation badge/sketch
backing, detail-tab attachment resolution + card clip, close-on-open-studio, header actions, deps chip
truncation. Suite 2288 green, browser gate green, maintainer PASS on installed 0.55.12. Follow-ups queued:
t-321e9d (pin-preview inline image), doc read-access via bridge tools (spec F15 limitation).
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence). -->

**Verify:** `npm test -- --run test/unit/docMarkdown.test.ts test/unit/markdownDoc.test.ts test/unit/studioModel.test.ts test/unit/taskDetailStore.test.ts`
**Verify:** `npm run typecheck`
**Dogfood:** `npm test -- --run test/unit/studioModel.test.ts -t "no-op"`

## Intent

Mission Control (spec 335) shipped with a deliberately minimal quick-add and a read-mostly detail tab. The
maintainer's dogfood verdict (queue task t-a11f0e): creating and editing a task deserves the same authoring
surface a pin gets — **Task Studio**, a full form in a NEW editor view with feature parity to Pin Studio:
big title, rich text editor with toolbar (bold/italic/code/lists/checklist/quote), **Sketch** (excalidraw),
**Import**, a Visuals panel with pasted/dropped/annotated screenshots, Save/Cancel — plus the task fields
(kind, priority, assignee, deps, artifact_refs) where a pin has tags. It REPLACES the board's quick-add.

### Authoring-truth model (dueto F1/F2/F15/F18, accepted via a simpler mechanism)

Three writers exist and the design must reconcile them: the Studio's rich doc, agents via `update_task`
(body), and direct file edits. The contract is **body-hash anchoring — the most recent writer wins and
`task.body` is the interchange format**:

- The per-task JSON in `.tachyon/tasks/` stays the queue's canonical record (325 untouched). The rich doc
  is a SIDECAR (`.tachyon/tasks/details/<id>.json`, `schemaVersion: 1`, Tiptap doc + attachment metadata +
  `bodyHash` + the task `updatedAt` it was saved against).
- **Load**: sidecar exists AND `sidecar.bodyHash === hash(task.body)` → the doc is the richer rendering of
  the current body; edit the doc. Otherwise (no sidecar, or body changed externally since the sidecar was
  written) → the doc is REIMPORTED from `task.body` markdown — an agent's external edit always wins; rich
  formatting beyond markdown is what may be lost, never content.
- **Save (doc dirty)**: serialize doc → markdown, write `task.body` via the guarded store path, write the
  sidecar with the new doc + `bodyHash` of the body just written.
- **Save (doc NOT dirty)**: `body` is NOT rewritten — a no-op open+save never touches an agent's carefully
  written markdown (byte-identical preservation, unit-tested with representative agent-authored markdown:
  tables, nested fences, HTML, link titles).
- No doc/body merge EVER in v1 (F18): on a CAS conflict the Studio offers reload-latest (reimport from the
  fresh body) or export-local-draft; scalar dirty fields recompute into a new patch.

## Acceptance criteria

- [x] **Scenario: create from the board** (F7/F11/F12/F19 folded)
  - **Given** the board's "+ Task" button, its former quick-add keyboard path, or the command palette
  - **When** the user invokes create
  - **Then** Task Studio opens as a new editor tab in NEW-TASK mode (panel-manager: one new-task panel per
    workspace + one per task id for edits) showing the FULL field set except status/rank — title, kind,
    priority, deps, artifact_refs enabled; **assignee visible but disabled with a "assign during triage"
    hint** (325's mutability table: assignee is triaged/active-only, and new tasks are born inbox);
    Save is a staged transaction: mint id → write sidecar to temp → `TaskStore.create` (author `"human"`,
    status inbox, body derived from doc) → promote sidecar atomically; any failure cleans temp and surfaces
    the error (orphans fall to the lifecycle rule below); after Save the board focuses/reveals the new
    inbox card (or confirms creation when the active filter hides inbox); Cancel closes without a task;
    spec-335 quick-add tests are UPDATED to cover the new path, not deleted
- [x] **Scenario: edit an existing task**
  - **Given** a card (context menu "Edit in Studio") or the detail tab (button)
  - **When** the Studio opens for that task id (re-invoking focuses the existing tab — never two editors
    for one id)
  - **Then** it loads title/fields/doc per the authoring-truth model above, and Save composes a
    **dirty-field patch only** (F4): exclusively the fields the user actually edited (title, body-via-doc,
    kind, priority, assignee, deps, artifact_refs), never status/rank, never untouched fields received via
    live fan-out — with CAS `expect:{updatedAt}` from load/last-refresh time; CAS failure = stale-editor
    treatment with the conflict choices from the model above, never a silent overwrite
- [x] **Scenario: editor parity via explicit extraction boundary** (F8)
  - **Given** the Studio editor area
  - **Then** it offers the pin toolbar set (bold, italic, code, bullet/ordered list, checklist, quote,
    sketch, import) + the Visuals paste/drop/import/annotate panel, built by EXTRACTING entity-neutral
    modules from pin-studio (RichDocEditor + toolbar registry, doc serializer/importer, VisualsPanel,
    attachment metadata types + store interface) consumed through thin PinStudioAdapter/TaskStudioAdapter
    seams (entity type, id, sidecar path, attachment namespace, save semantics) — task code never imports
    pin-specific stores/paths directly, and shipped Pin Studio behavior is protected by its existing tests
- [x] **Scenario: task fields** (F17)
  - **Then** kind (free-text ≤64), priority (none/P0–P3), assignee (edit mode only; free-text with
    known-agent hints), deps (chips validated by the TaskStore id parser — not a re-encoded regex — with
    self-dep and duplicate rejection and title resolution), artifact_refs (type+ref pairs obeying 325's
    max-10/dedupe/bounds, per-chip validation before Save) all use themed controls and fail closed with the
    store's message; STATUS is deliberately NOT editable (board/detail own transitions)
- [x] **Scenario: body derivation** (F3/F20 folded)
  - **When** a dirty doc serializes on Save
  - **Then** if the markdown is ≤4000 code points it is stored unchanged; otherwise body = prefix + stable
    non-localized ASCII marker `\n\n[truncated: full doc in Task Studio]` with TOTAL length ≤4000 code
    points, prefix cut preferring block boundary then line boundary, never splitting a surrogate pair,
    closing an open fenced code block before the marker when it fits — marker is machine-detectable and
    covered by exact-boundary tests; board cards and the detail tab keep rendering `task.body` unchanged;
    `get_task`/`list_tasks` are unchanged in v1 (the sidecar is invisible to bridge tools — an explicit
    LIMITATION for agents working long-form tasks; a follow-up queue task must expose read-only doc access
    before Task Studio becomes the vehicle for agent-critical long-form specs — F15)
- [x] **Scenario: attachments + sidecar lifecycle** (F5/F6/F9/F13/F21 folded)
  - **Then** binaries persist through the shared attachment-store mechanism under an entity-typed
    namespace (`.tachyon/tasks/attachments/<task-id>/…`; sidecar refs are relative logical attachment ids,
    validated against the task's namespace — traversal and cross-entity refs rejected); large binaries are
    attachments, never base64 inside the Tiptap JSON, with soft-warn/hard-block size limits on the sidecar
    doc; lifecycle: missing sidecar = valid (import from body); malformed or unknown-newer schemaVersion =
    fail-closed read-only (never overwritten by Save without explicit recovery), scalar task edits still
    work; DROPPED tasks keep sidecar + attachments; hard deletion removes them best-effort with logged
    failures; attachment refs removed from the sidecar garbage-collect their binaries best-effort; orphan
    sidecars (no task file) are ignored at runtime
- [x] **Scenario: concurrent safety** (F10/F18 folded)
  - **Given** an open Studio while agents/board mutate the task
  - **Then** the live fan-out updates non-dirty scalar fields in place and shows a freshness banner naming
    externally changed fields; the rich doc NEVER auto-merges; board-owned changes (status/rank) never
    force a body/title rebase — Save's dirty-field patch simply excludes them; after a CAS failure the
    Studio reloads the latest task+sidecar, recomputes the dirty patch, and the user explicitly retries
- [x] House webview stack + CSP; import/paste sanitized through the shared safe pipeline (accepted binary
  types + max sizes enumerated; SVG rejected or sanitized; attachment metadata schema-validated; logical
  ids only) (F16); excalidraw/annotation modules lazy-load on first use, panel dispose releases editor
  state/object URLs/canvases, background panels run no render loops (F14)
- [x] Pure, unit-tested modules (DOM-free): doc→markdown with truncation boundaries, body→doc import with
  no-op round-trip preservation, dirty-field patch composition (proving untouched/externally-updated fields
  are never sent), bodyHash anchoring decisions (F22 partially) — PLUS integration coverage for: create
  transaction failure cleanup, edit-with-missing-sidecar, CAS conflict against a concurrent update_task,
  attachment add/remove GC, and "+ Task" board flow (F22)
- [x] The board's inline quick-add UI is removed; every create path (button, shortcut, palette) opens the
  Studio (F12)

## Non-goals

- Status/rank transitions inside the Studio (board/detail own them; rank is the v1.1 gate, task t-9a41b2).
- Exposing the rich doc or attachments through bridge tools in v1 (explicit limitation above; follow-up
  queue task required before agent-critical long-form use).
- Editing `author`, `createdAt`, or the task id; pin↔task conversion; templates; custom fields; bulk edit.
- Document merging of any kind (reload-or-export only in v1).

## Open questions

_The three draft-time forks were resolved during the dueto fold: create mode shows the full field set with
assignee disabled-by-mutability-table (F7); attachment storage reuses the shared mechanism behind an
adapter + entity-typed namespace (F8/F9); deps editor is chip-input with store-parser validation (F17 —
picker remains a possible follow-up)._

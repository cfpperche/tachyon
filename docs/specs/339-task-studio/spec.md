# 339 — task-studio

_Created 2026-07-03._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence). -->

## Intent

Mission Control (spec 335) shipped with a deliberately minimal quick-add (title/kind/body) and a read-mostly
detail tab. The maintainer's dogfood verdict (queue task t-a11f0e): creating and editing a task deserves the
same authoring surface a pin gets — **Task Studio**, a full form in a NEW editor view with feature parity to
Pin Studio: big title, rich text editor with toolbar (bold/italic/code/lists/checklist/quote), **Sketch**
(excalidraw), **Import**, a Visuals panel with pasted/dropped/annotated screenshots, Save/Cancel — plus the
task-specific fields (kind, priority, assignee, deps, artifact_refs) where a pin has tags. It REPLACES the
board's quick-add: "+ Task" opens Task Studio in new-task mode.

Storage follows the pin pattern without touching the shipped 325 entity: the per-task JSON in
`.tachyon/tasks/` remains the queue's canonical record; the rich document is a SIDECAR detail file
(`.tachyon/tasks/details/<id>.json`: schemaVersion + Tiptap doc + attachment metadata, binaries via the
attachment store), and `task.body` is DERIVED from the doc on save (markdown serialization, ≤4000 code
points with truncation marker) so agents reading `get_task` always see what the human authored — one
authoring truth, no dual-write drift (same anti-drift principle as the SDD status derive).

## Acceptance criteria

- [ ] **Scenario: create from the board**
  - **Given** the board's "+ Task" button (or the command palette entry)
  - **When** the user clicks it
  - **Then** Task Studio opens as a new editor tab in NEW-TASK mode (panel-manager pattern; one "new task"
    panel per workspace, plus one per existing task id for edits) with empty title, empty doc, and the task
    fields at their creation defaults (no priority/assignee — triage stays a deliberate later gesture);
    Save calls `TaskStore.create` (author `"human"`) + writes the sidecar; Cancel closes without a task
- [ ] **Scenario: edit an existing task**
  - **Given** a card on the board or the task detail tab
  - **When** the user picks "Edit in Studio" (card context menu entry + a button on the detail tab)
  - **Then** Task Studio opens for that task id (re-invoking focuses the existing tab), loading title,
    fields, and the rich doc (from the sidecar when present; otherwise the doc is IMPORTED from `task.body`
    markdown so agent-created tasks are editable losslessly-enough), and Save persists via the same guarded
    path (`TaskStore.update` with CAS `expect:{updatedAt}` from load time — a CAS failure surfaces the
    stale-editor treatment, never a silent overwrite)
- [ ] **Scenario: editor parity with Pin Studio**
  - **Given** the Studio editor area
  - **When** the user authors content
  - **Then** the Tiptap editor offers the pin toolbar set (bold, italic, code, bullet/ordered list,
    checklist, quote, sketch, import) and the Visuals side panel accepts paste/drop/import of images with
    the annotate flow — the SAME shared components/pipeline as Pin Studio (no forked editor code; extract
    shared modules if needed rather than copying)
- [ ] **Scenario: task fields**
  - **Given** the fields row/section of the Studio
  - **When** the user edits kind, priority, assignee, deps, or artifact_refs
  - **Then** each uses a themed control (kind free-text ≤64, priority none/P0–P3, assignee free-text with
    the board's known-agent hints, deps as task-id chips validated `t-<6hex>` and resolved to titles when
    they exist, artifact_refs as type+ref pairs) and invalid values fail closed with the store's message —
    STATUS is deliberately NOT editable in the Studio (transitions belong to the board/detail, where the
    store's gates and affordances already live)
- [ ] **Scenario: body derivation (one authoring truth)**
  - **Given** a task saved from the Studio with a rich doc
  - **When** the doc is serialized
  - **Then** `task.body` is written as the doc's markdown rendering, truncated at the entity's 4000-code-
    point bound with a trailing `… (truncated — full doc in Task Studio)` marker when needed; board cards
    and the detail tab keep rendering `task.body` unchanged, and `get_task`/`list_tasks` need no schema
    change (sidecar is invisible to the bridge tools in v1)
- [ ] **Scenario: attachments**
  - **Given** pasted/dropped/annotated images in the Visuals panel
  - **When** the task is saved
  - **Then** binaries persist through the SAME attachment-store mechanism pins use (task-scoped paths),
    sidecar metadata references them relatively, and deleting the task removes its sidecar + attachments
    (best-effort, like pin delete)
- [ ] **Scenario: concurrent safety**
  - **Given** an open Studio for a task that an agent then mutates (status/assignee via bridge tools)
  - **When** the live task-change fan-out fires
  - **Then** the Studio shows a non-destructive freshness banner (fields update if untouched; the user's
    in-progress edits are NEVER discarded), and Save still goes through CAS — on mismatch the banner
    explains and offers reload-and-reapply, mirroring the edit-session rules the board established
- [ ] The Studio panels use the house webview stack + CSP posture; new Tiptap/excalidraw bundles reuse the
  pin-studio build entry pattern
- [ ] Pure, unit-tested modules for: doc→markdown serialization with the 4000-bound truncation, body→doc
  import, and the fields-patch composition (including CAS expect) — DOM-free
- [ ] The board's old inline quick-add form is REMOVED ("+ Task" now opens the Studio; one creation path)

## Non-goals

- Status transitions inside the Studio (board/detail own them; one authority for gates and affordances).
- Exposing the rich doc or attachments through bridge tools (`get_task` stays body-only in v1; an
  `artifact_refs` convention or tool extension is a follow-up decision).
- Editing `author`, `createdAt`, or task id; any rank editing (v1.1 gate, task t-9a41b2).
- Pin↔task conversion or any pin integration (independence decision stands).
- Templates, custom fields, or multi-task bulk editing.

## Open questions

- Attachment store scope: reuse PinAttachmentStore with a task namespace vs. a parallel TaskAttachmentStore
  sharing the same implementation — decide in plan after reading the store's coupling to pin ids.
- Deps editor UX: free chip input only, or a picker listing open tasks? (v1 proposal: chip input with
  validation + title resolution; picker is a follow-up.)
- Should Save on a NEW task land it in `inbox` always (creation posture), even though the Studio exposes
  priority/assignee fields? (v1 proposal: yes — fields other than title/kind/body/doc are enabled only in
  EDIT mode, keeping create-then-triage intact.)

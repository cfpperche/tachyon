# 339 — task-studio — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Extraction first; pin-studio tests must be
green at EVERY commit. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] T1 Extraction (no behavior change): move entity-neutral modules from pin-studio to
  `src/webview/rich-doc/` (document/tiptap/data-url/Visuals tree/attachment VM types), introduce the
  `StudioAdapter` seam + `PinStudioAdapter`; pin-studio consumes the extracted modules; excalidraw bundle
  stays shared; pin-studio unit tests untouched and green.
- [x] T2 Attachment namespace: shared blob/scene base + `TaskAttachmentStore`
  (`.tachyon/tasks/attachments/<task-id>/…`, task-id parser validation, same type/size/scene rules) +
  tests incl. traversal/cross-entity rejection.
- [x] T3 `TaskDetailStore` sidecar CRUD (schemaVersion 1, bodyHash, taskUpdatedAt echo, atomic writes,
  lifecycle rules, staged create-transaction helper, delete + attachment GC best-effort) + tests for every
  lifecycle rule in the spec.
- [x] T4 Pure serialization modules: `docMarkdown.ts` (per-node serializer + truncation boundaries),
  `markdownDoc.ts` (body→doc import), `studioModel.ts` (bodyHash anchoring decisions + dirty-field patch
  composition) — exhaustive unit tests: per-node cases, truncation exact boundaries, NO-OP ROUND-TRIP
  PRESERVATION on representative agent markdown (tables, nested fences, HTML, link titles), untouched
  fields never in the patch.
- [x] T5 `TaskStudioPanelManager` + `task-studio` webview surface (create + edit modes per spec, fields
  row with store-parser validation, freshness banner, CAS conflict flow, lazy excalidraw, dispose
  discipline) + esbuild entry + panel tests (pinStudioPanel.test.ts pattern).
- [x] T6 Wiring: "+ Task"/shortcut/palette → Studio; card context menu "Edit in Studio"; detail-tab
  button; quick-add UI removed with spec-335 tests UPDATED (not deleted); post-Save reveal/confirm;
  deletion path cleanup; i18n strings (en/pt-br).
- [x] T7 Hardening + integration: import/paste sanitization rules (types/sizes/SVG), integration tests
  from the spec list (create-failure cleanup, missing-sidecar edit, CAS vs concurrent update_task,
  attachment add/remove GC, board "+ Task" flow); full suite + both typechecks green.

## Verification

- [x] Authoring-truth model: bodyHash anchoring decisions + no-op preservation + external-edit reimport —
  studioModel/docMarkdown/markdownDoc unit tests.
- [x] Truncation ≤4000 total incl. stable marker, boundary rules — exact-boundary tests.
- [x] Dirty-field patch excludes untouched/board-owned fields — studioModel tests.
- [x] Sidecar lifecycle rules (missing/malformed/newer/dropped/delete/GC/orphan) — TaskDetailStore tests.
- [x] Attachment namespace validation — TaskAttachmentStore tests.
- [x] Create staged transaction failure cleanup — integration test.
- [x] Pin-studio regression: its existing suite green at every commit + human smoke in dogfood.
- [x] `npm test` and both typechecks green — 160/160 files, 2237 tests, both typechecks clean. (The
  external `src/bridge/tools.ts` WIP noted mid-T7 — see notes.md — resolved on its own by the time of this
  final check; it was never spec-339's to fix.)

**Headless check:** `npm test -- --run test/unit/docMarkdown.test.ts test/unit/markdownDoc.test.ts test/unit/studioModel.test.ts test/unit/taskDetailStore.test.ts test/unit/taskAttachmentStore.test.ts && npm run typecheck`

**Verify:** `npm test -- --run test/unit/docMarkdown.test.ts test/unit/markdownDoc.test.ts test/unit/studioModel.test.ts test/unit/taskDetailStore.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npm test -- --run test/unit/studioModel.test.ts -t "no-op"`
<!-- Headless proxy: the no-op preservation invariant exercises the full load→decide→save pipeline the
     Studio depends on. The surfaces need the human pass below. -->

**Human dogfood:** Install the VSIX. (1) "+ Task" → Studio create mode: full fields except assignee
(disabled + hint), author rich body with a screenshot paste and a sketch, Save → task lands in Inbox,
board reveals it, body shows derived markdown. (2) Open an AGENT-created task (has body, no sidecar) in
Studio, Save WITHOUT edits → body byte-identical (verify via git diff or file mtime/content). (3) Edit it,
Save → body updates, reopen → doc preserved (hash match). (4) Have an agent update_task the body while the
Studio is open → freshness banner; reload → doc reimported from the agent's body. (5) Pin Studio smoke:
open a pin, toolbar + visuals still work. (6) Truncation: paste a huge doc, Save → body ends with the
stable marker within 4000.

## Visual QA

- [ ] Evidence: agent-screen captures — Studio create mode, edit mode with Visuals populated, freshness
  banner, and a pin-studio regression shot.
- [ ] Verdict:

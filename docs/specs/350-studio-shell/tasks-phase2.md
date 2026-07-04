# 350 Phase 2 — Task Studio migration — tasks (t-03870f)

_Generated 2026-07-04. THE GUARD: 339 behavioral tests stay green UNCHANGED except where they asserted
replaced plumbing (message shapes / panel internals). A behavioral test needing a real change = a
regression, STOP. Commit per task by pathspec. 349 plugin WIP is live — git status before every commit._

## Implementation

- [x] T1 TaskStudioAdapter: implement StudioHostAdapter<TaskDetailEntity,TaskFields,TaskPatch> WRAPPING
  TaskDetailStore/TaskAttachmentStore — load (task+sidecar or import-from-body), save (CAS update OR staged
  create w/ cleanup), delete, concurrency {kind:"cas"} carrying bodyHash, dirty hooks (computeDirty/
  serializePatch/canDiscard emitting the SAME partial patch). Unit tests for the adapter in isolation.
- [x] T1.5 (Amendment 2, approved — pin p-9eb9bd, notes.md) additive StudioSurfaceConfig CSP/bootstrapGlobals
  passthrough: connectSrc/workerSrc/childSrc/imgBlob + bootstrapGlobals(uri) threaded through open()'s
  renderWebviewShell call — a prerequisite for T2/T3 wiring Excalidraw sketch support. Phase 1 fakes unaffected.
- [x] T2 TaskStudioPanel → thin over StudioPanelManagerBase + the adapter; public entry points
  (openNew/openForTask) unchanged; domain messages → protocol extension slot. taskStudioPanel.test.ts
  adjusted ONLY for plumbing; behavioral asserts unchanged and green. Includes Amendment 3 (approved —
  notes.md, commit bd4fdbb): additive adapter `onCancel` hook, closing the staged-create cleanup-on-cancel
  gap the migration surfaced (13/14 → 14/14 green).
- [x] T3 task-studio/App.tsx renders in StudioFrame: fields region (Kit* controls), richDoc/previewVisual
  regions (doc + visuals), header action slots (Import/Sketch/Cancel/Save). If visuals don't fit a region,
  notify claude (shell amendment, not a hack).
- [ ] T4 Shell-level conflict test: an external task update mid-edit surfaces the freshness banner through
  the shell's cas ConcurrencyContract path (proves the real hard case the Pipeline fake only simulated).
- [ ] T5 Full suite + both typechecks green; agent visual pass on the task-studio preview route (create +
  edit modes, dirty, conflict) vs "chrome identical to the shell, 339 behavior intact"; confirm no other
  studio touched.

## Verification

- [ ] 339 authoring contract intact: body-hash anchoring, dirty-patch shape, staged-create cleanup,
  freshness banner — behavioral tests green UNCHANGED (T2/T4).
- [ ] Adapter wraps stores without store changes — T1 tests + `git diff --stat` shows no TaskStore/
  TaskDetailStore/TaskAttachmentStore edits.
- [ ] Entry points unchanged — extension.ts untouched (`git diff` empty for it).
- [ ] cas conflict surfaces via shell path — T4.
- [ ] `npm test` + both typechecks green.

**Headless check:** `npm test -- --run test/unit/taskStudioPanel.test.ts test/unit/studioPanelBase.test.ts && npm run typecheck`

**Verify:** `npm test -- --run test/unit/taskStudioPanel.test.ts test/unit/studioPanelBase.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npm test -- --run test/unit/taskStudioPanel.test.ts`
<!-- The unchanged behavioral suite passing over the migrated plumbing IS the proof of no regression. -->

**Human dogfood:** Install; open a task in Studio (edit mode) — save an unedited agent-created task, body
byte-identical; edit + save, reopen, doc preserved; have an agent update the task mid-edit → freshness
banner; create a new task via "+ Task" (staged create). Same behavior as 339, one shared chrome.

## Visual QA

- [ ] Evidence: agent-browser captures of task-studio (create, edit, dirty, conflict) on the migrated shell.
- [ ] Verdict:

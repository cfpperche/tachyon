# 350 Phase 2 — Task Studio migrates to the studio shell — plan (t-03870f)

_Drafted 2026-07-04. The Phase 1 shell (src/webview/shared/studio/) is proven by two fakes; this migrates
the REAL, delicate Task Studio onto it with ZERO behavior regression to the 339 authoring contract._

## The invariant that governs everything

339's authoring contract must survive byte-for-byte in observable behavior:
- **body-hash anchoring** (TaskStudioPanel.ts:302 — sidecar {bodyHash, taskUpdatedAt}) maps to the shell's
  `ConcurrencyContract {kind:"cas"}` with the expected-hash/updatedAt carried through StudioConcurrencyState.
- **dirty-patch** → the adapter's StudioDirtyHooks (computeDirty/serializePatch/canDiscard); serializePatch
  emits the SAME partial patch (body only when the doc changed; expectUpdatedAt from load).
- **staged create** (mint id → temp sidecar → TaskStore.create → promote; cleanup on failure,
  TaskStudioPanel.ts:175/265) → the adapter's save() for the new-entity mode, cleanup preserved.
- **freshness banner** (external update mid-edit) → the shell's DirtyBannerInput/StudioConcurrencyState.

## Approach

1. **`TaskStudioAdapter` (host)** implementing `StudioHostAdapter<TaskDetailEntity, TaskFields, TaskPatch>`:
   load (task + sidecar or import-from-body), save (update via CAS OR staged-create), delete/cleanup,
   concurrency: {kind:"cas"} with bodyHash, dirty hooks. It WRAPS the existing TaskDetailStore/
   TaskAttachmentStore logic — no store changes.
2. **TaskStudioPanel → thin subclass/config of `StudioPanelManagerBase`**: the ~355 lines of hand-rolled
   lifecycle/message-dispatch collapse into the adapter + the base; keep the panel's public entry points
   (openNew/openForTask) identical so extension.ts wiring is untouched.
3. **task-studio/App.tsx → renders inside `StudioFrame`**: fields row (kind/priority/assignee/deps/
   artifact_refs — already Kit* from the polish waves) go into the frame's `fields` region; the rich doc +
   visuals into `richDoc`/`previewVisual` regions; header actions (Import/Sketch/Cancel/Save) into the
   frame's action slots. Domain messages (doc/attachment ops) ride the protocol's registered extension slot.
4. **Tests**: the 339 behavioral suites (taskStudioPanel.test.ts, the markdown/serializer tests) stay green
   UNCHANGED where they encode behavior; adjust ONLY where they asserted the replaced plumbing (message
   shapes, panel internals). ADD shell-level conflict tests (CAS mismatch surfaces the freshness banner via
   the shell path).

## Key decisions

- Adapter WRAPS, never rewrites, TaskDetailStore/TaskAttachmentStore — the 339 storage contract is law.
- cas ConcurrencyContract is the shell's home for body-hash anchoring — no bespoke freshness code survives
  in task-studio; it flows through the shared StudioConcurrencyState (proves the shell's cas path on the
  real hard case, which the Pipeline fake only simulated).
- Public panel entry points unchanged → extension.ts + command wiring untouched (bounds blast radius).

## Files touched

- src/webview/TaskStudioPanel.ts (→ thin over the base + new TaskStudioAdapter, likely a new adapter file).
- src/webview/task-studio/App.tsx (→ renders in StudioFrame; fields already Kit*).
- src/webview/task-studio/messages.ts (domain messages → protocol extension slot).
- NO changes to: TaskStore/TaskDetailStore/TaskAttachmentStore (339 storage), the shell itself (Phase 1),
  extension.ts (entry points preserved), any other studio.
- Tests: taskStudioPanel.test.ts (adjust plumbing asserts), + new shell-conflict test.

## Risks

- Task Studio JUST shipped (339) and had 4 dogfood waves — the migration must be behavior-preserving; the
  regression guard is the UNCHANGED behavioral tests. If a test needs changing for anything other than a
  message-shape/panel-internal reason, STOP — that is a real regression, not plumbing.
- 349 plugin WIP is live in the webview tree (plugin-host/) — disjoint from task-studio/shared/studio, but
  git status before every commit.
- The rich-doc/visuals regions are the least-exercised shell path (Pipeline fake had no rich doc) — this is
  where region composition gets its first real test; if a region can't hold visuals, that's a shell
  amendment (notify claude), not a task-studio hack.

## Sources consulted

spec 350 (Phase 2 criterion) + Phase 1 shell (adapter.ts, StudioPanelManagerBase.ts, StudioFrame.tsx,
protocol.ts, dirtyGating.ts) · 339 TaskStudioPanel.ts (body-hash :302, staged create :175/265, expect :137)
· task-studio/App.tsx (Kit* fields) · TaskDetailStore/TaskAttachmentStore (the storage contract to wrap).

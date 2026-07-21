export const TASK_DETAIL_VIEW_TYPE = "tachyonTaskDetail";

/**
 * t-610705 (SDD 410 Phase C.1) — the standalone Task Detail panel was retired: Task Detail is a
 * Control subroute now (mission/task/<id> — src/webview/task-detail/App.tsx stays, lazy-imported by
 * cockpit/App.tsx; Cockpit.ts builds the projection via src/cockpit/taskDetailVm.ts, which carries
 * the tombstone contract verbatim — dueto F8, spec 335: a task that disappears or becomes
 * unparseable renders its last-known state instead of an empty screen).
 *
 * `open()` was already fully unreachable before this retirement (only `.refreshAll()`/`.dispose()`/
 * `.deserialize()` had any real caller in extension.ts) — unlike Board/Approvals/Plugins/tmux, there
 * was no "legacy open path" to redirect; a revived pre-410 panel disposes itself and redirects
 * straight into Control → the task's subroute (see the trusted serializer in extension.ts).
 */
export interface TaskDetailPanelState {
  schemaVersion: 1;
  view: typeof TASK_DETAIL_VIEW_TYPE;
  wsHash: string;
  taskId: string;
}

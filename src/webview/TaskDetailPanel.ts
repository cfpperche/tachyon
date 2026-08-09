import * as vscode from "vscode";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelState,
  type SectionPanelTarget,
} from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { buildTaskDetailVm, emptyTombstoneVm } from "./task-detail/taskDetailVm.js";
import { taskDocumentModeMessage, taskMessage, taskDetailErrorMessage, type TaskDetailAction } from "./task-detail/messages.js";
import { READY } from "./shared/ready.js";
import type { WorkspaceTaskDetailTarget } from "../shell/TaskDetailTarget.js";
import type { TaskDetailProjectionV1 } from "../runtime-api/taskDetailProjection.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import type { WorkspaceTaskStudioTarget } from "../shell/TaskStudioTarget.js";
import { TaskStudioAdapter } from "./TaskStudioAdapter.js";
import { decodeStudioMessage, envelope } from "./shared/studio/protocol.js";
import { mapUnknownError } from "./shared/studio/errorTaxonomy.js";
import { handleTaskStudioDomainMessage } from "./task-detail/taskStudioDomain.js";
import { TaskDocumentEditPolicy, type TaskDocumentDraft } from "./task-detail/editPolicy.js";
import type { TaskPatch } from "./task-studio/domain.js";
import { confirmDocumentStudioCancel } from "./shared/studio/documentStudioCancel.js";

export const TASK_DETAIL_VIEW_TYPE = "tachyonTaskDetail";

/** the one refresh kind this app knows: "the task you are showing may have changed". */
type TaskDetailRefreshKind = "task";

/**
 * The persisted shape the STANDALONE panel wrote before SDD 410 retired it (`wsHash` + `taskId`). It is not
 * what this app persists — `SectionPanelManager` writes `project` + `identity` — but the viewType is the
 * same, so a window that has been closed since before 410 can still hand us one of these. `migrateLegacy`
 * below is the whole of the compatibility shim, and it has no UI: it translates two field names.
 */
export interface TaskDetailPanelState {
  schemaVersion: 1;
  view: typeof TASK_DETAIL_VIEW_TYPE;
  wsHash: string;
  taskId: string;
}

/**
 * SDD 485 C4 — the Task Detail app: the FIRST shipped surface on `SectionPanelManager`, and the case the
 * spec's "twelve sections" framing would have missed entirely. Cardinality `document`, so the manager keys a
 * panel by `viewId | project | identity` and two task details from two projects are two editor tabs that
 * stay their own task. That is the maintainer's motivating case #2, and it is a capability one panel could
 * not offer at any amount of polish (`spec.md`, Intent).
 *
 * ## Identity is FIXED AT OPEN, and that is a correctness rule
 *
 * `session.target` is frozen by the manager when the panel is created, and EVERY read below resolves its
 * workspace from `session.target.project` — never from a "current project" the shell holds. Switching the
 * sidebar's project selector changes what the NEXT thing opens against; it can never change what an open
 * document IS. Without that, two task details side by side silently become different documents the moment a
 * human touches a dropdown, and the delivery fails the case that justifies it (`route.ts:37` already treated
 * a task detail's `wsHash` as identity rather than preference — this file is where that becomes structural
 * instead of a routing convention).
 *
 * ## What this file has to say is small, on purpose
 *
 * A manifest row, a title, a stylesheet list, and a `bind` that answers three questions: how to replay one
 * invalidation, how to rebuild, and what an inbound message means. The key, the cardinality rule, the shared
 * shell, the visibility gate, the persisted state, reveal-on-reopen and revive all belong to the manager and
 * are not restated here — which is the whole point of C1 having landed first.
 *
 * ## The tombstone contract, now per panel
 *
 * `lastKnown` lives inside `bind`, so it is PER PANEL. Control could only keep one slot ("at most one
 * task-detail route is ever open" — its own comment), which was true of a singleton and is false of a
 * document app. Each panel remembers its own last good projection and renders it when the task's file
 * disappears or becomes unparseable, rather than an empty screen (dueto F8, spec 335, carried forward).
 */
export class TaskDetailPanelManager {
  private readonly manager: SectionPanelManager<TaskDetailRefreshKind>;
  private readonly drafts = new Map<string, TaskDocumentDraft<TaskPatch>>();
  /**
   * t-3c8f2a — the keys whose task has never been saved.
   *
   * "New Task" opens a document against a PRE-MINTED id, so the panel exists before the entity does.
   * Without this set the document could not tell that apart from a task that is merely closed, and
   * Cancel dropped the human on a read view of something that was never on disk ("Task t-… never
   * found on disk"). The Pins document already had this distinction; the task document did not.
   */
  private readonly provisional = new Set<string>();

  constructor(
    extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => WorkspaceTaskDetailTarget[],
    private readonly hooks: {
      /** the shared fan-out every task mutation goes through (board, sidebar, this app). */
      onTasksChanged: () => void;
      /** open Task Studio for this task — Control still owns the studio routes (SDD 485 Phase D/E). */
      openTaskStudio: (ws: WorkspaceTaskDetailTarget, taskId: string) => void;
    },
    app: WebviewAppEntry = webviewApp("task-detail"),
    workspaceScope?: ControlWorkspaceScope,
    private readonly getStudioWorkspaces: () => WorkspaceTaskStudioTarget[] = () => [],
  ) {
    this.manager = new SectionPanelManager<TaskDetailRefreshKind>(extensionUri, this.configFor(app), workspaceScope);
  }

  /** Open the task's own editor tab, or REVEAL it if this identity is already open. */
  open(wsHash: string, taskId: string): void {
    this.manager.open({ project: wsHash, identity: taskId });
  }

  /** `studio-edit(task)` and the read-mode button share this door: same target, therefore same panel. */
  openEdit(wsHash: string, taskId: string): void {
    const target = { project: wsHash, identity: taskId };
    this.manager.open(target);
    this.manager.post(target, taskDocumentModeMessage("edit"));
  }

  /**
   * t-3c8f2a — "New Task": a document opened against an id nothing has written yet.
   *
   * Separate from `openEdit` for two reasons the Board's + Task button paid for. The mode is DERIVED
   * from `provisional` rather than posted after `open()` — the post raced the webview mount and won
   * only by luck here, and lost every time in the Pins equivalent (t-883386). And Cancel has to close
   * the tab rather than fall back to read mode, because there is no entity to read.
   */
  openCreate(wsHash: string, taskId: string): void {
    const target = { project: wsHash, identity: taskId };
    this.provisional.add(this.manager.keyFor(target));
    this.manager.open(target);
  }

  openInCurrentScope(taskId: string): boolean {
    return this.manager.openInCurrentScope(taskId);
  }

  /** the fan-out door — every open task detail re-reads. Returns how many panels did work. */
  refresh(): number {
    return this.manager.refresh("task");
  }

  /** the upstream event cursor expired: hidden panels rebuild instead of replaying on reveal. */
  markSourceResync(): void {
    this.manager.markSourceResync();
  }

  /**
   * Revive a panel VS Code restored across a window reload. Accepts BOTH this app's own persisted state and
   * the pre-410 standalone panel's (`wsHash`/`taskId`) — same viewType, so both can arrive here, and a
   * legacy record deserves the task it named rather than a disposed tab.
   */
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState | TaskDetailPanelState): void {
    this.manager.deserialize(panel, migrateLegacy(state));
  }

  get openKeys(): string[] {
    return this.manager.openKeys;
  }

  dispose(): void {
    this.manager.dispose();
  }

  private configFor(app: WebviewAppEntry): SectionAppConfig<TaskDetailRefreshKind> {
    const resolveWs = (target: SectionPanelTarget): WorkspaceTaskDetailTarget | undefined =>
      this.getWorkspaces().find((w) => w.wsHash === target.project);

    return {
      app,
      // The exact set Control linked for a task-detail route, in the same order: the shared base, the
      // mermaid sheet MarkdownView's blocks need, then this surface's own. This phase changes where the
      // screen renders, not how it looks.
      styleFiles: [
        "codicon.css", "design-system.css", "vscode-theme.css", "task-studio.tailwind.css",
        "rich-doc.css", "studio-frame.css", "task-studio.css", "mermaid-block.css", "task-detail.css",
      ],
      csp: { frameSrc: "self", imgBlob: true, connectSrc: true, workerSrc: "blob" },
      bootstrapGlobals: (_target, uri) => ({
        EXCALIDRAW_SCRIPT_URI: uri("excalidraw.js"),
        EXCALIDRAW_CSS_URI: uri("excalidraw.css"),
        EXCALIDRAW_ASSET_PATH: uri("").replace(/\/?$/, "/"),
      }),
      // Both carried forward verbatim from the pre-410 standalone panel this restores — the tab a human
      // used to see for a task is the tab they see again.
      title: (target) => `Task ${target.identity ?? ""}`.trim(),
      iconName: "note",
      // t-4d59d3 — the blob root must be an allowed local resource root before `asWebviewUri` can resolve
      // `attachment:<id>` refs in the body. Granted ONCE at creation, and only for THIS document's own
      // workspace: Control had to grant every workspace's attachments parent because one panel served them
      // all, which is precisely the coupling a per-identity panel removes.
      extraLocalResourceRoots: (target) => {
        const ws = resolveWs(target);
        return ws ? [vscode.Uri.file(ws.attachmentsRoot())] : [];
      },
      // The client's handshake and its explicit Refresh are the same thing to the host: "post me the task".
      // Routing them through the gate rather than to `onMessage` is what makes a hidden panel's request cost
      // nothing (SDD 485 Phase B's loudest finding, generalized by C1).
      refreshKindFor: (message) => {
        const raw = message as { type?: unknown; studioProtocolVersion?: unknown } | undefined;
        return (raw?.type === READY && raw.studioProtocolVersion === undefined) || raw?.type === "requestSnapshot"
          ? "task"
          : undefined;
      },
      bind: (session) => {
        // `sectionPanelKey` refuses a `document` target missing either half, so a panel cannot exist
        // without both — the fallbacks are the type's shape, not a case that can be reached.
        const project = session.target.project ?? "";
        const taskId = session.target.identity ?? "";
        /**
         * The LAST KNOWN good projection for THIS panel. Ported from Control's single slot, which was
         * correct only because Control was a singleton — a document app has as many as it has tabs.
         */
        let lastKnown: TaskDetailProjectionV1 | undefined;
        const studioTarget = this.getStudioWorkspaces().find((w) => w.wsHash === project);
        const studio = studioTarget ? new TaskStudioAdapter(studioTarget) : undefined;
        // t-3c8f2a — a task that was never saved has no read model, so read mode would render
        // "never found on disk". The opening mode is the same fact as `persisted`.
        let persisted = !this.provisional.has(session.key);
        const policy = new TaskDocumentEditPolicy<TaskPatch>(persisted ? "read" : "edit", this.drafts.get(session.key));

        const postStudioError = (err: unknown): void => {
          const e = mapUnknownError("transport", err);
          session.post(envelope({ type: "error", code: e.code, message: e.message, source: e.source, blocking: e.blocking }));
        };

        const sendStudioLoad = async (): Promise<void> => {
          if (!studio) return;
          const result = await studio.load(taskId);
          if (result.status !== "ok") {
            postStudioError(new Error(result.status === "not-found" ? "not found" : result.error));
            return;
          }
          session.post(envelope({
            type: "load",
            entity: result.entity,
            concurrency: { kind: "cas", expected: studio.revisionOf(result.entity) },
          }));
          if (policy.draft.dirty && policy.draft.patch) {
            session.post(envelope({
              type: "restore",
              snapshot: { schemaVersion: 1, entityType: "task", mode: "edit", patch: policy.draft.patch },
            }));
          }
        };

        const sendTask = async (): Promise<void> => {
          const ws = resolveWs(session.target);
          if (!ws) {
            // A workspace that is not attached in this window (a revived panel from a folder since closed).
            // The document keeps its identity and says so, rather than redirecting away from itself.
            session.post(taskMessage(emptyTombstoneVm(project, taskId)));
            return;
          }
          const resolveBlobUri = (localPath: string): string => session.asWebviewUri(localPath);
          try {
            const detail = await ws.loadTaskDetail(taskId);
            lastKnown = detail;
            session.post(taskMessage(buildTaskDetailVm(ws, taskId, detail, false, resolveBlobUri)));
          } catch {
            // The file disappeared or became unparseable — render the LAST KNOWN state, never an empty
            // screen (dueto F8); a document never redirects away from itself on a load failure.
            session.post(taskMessage(lastKnown
              ? buildTaskDetailVm(ws, taskId, lastKnown, true, resolveBlobUri)
              : emptyTombstoneVm(project, taskId)));
          }
        };

        const fail = (err: unknown): void => {
          session.post(taskDetailErrorMessage(err instanceof Error ? err.message : String(err)));
        };

        const onAction = async (m: Partial<TaskDetailAction>): Promise<void> => {
          if (!m?.type) return;
          if (m.type === "openTask" && typeof m.id === "string") {
            // A dependency link opens the OTHER task as its own document — it never rewrites this one.
            // Control navigated in place because it had one panel to navigate; here, retargeting an open
            // document is exactly the thing the cardinality exists to forbid.
            this.open(project, m.id);
            return;
          }
          const ws = resolveWs(session.target);
          if (!ws) return;
          if (m.type === "openTaskStudio") {
            policy.switchMode("edit");
            session.post(taskDocumentModeMessage("edit"));
            void sendStudioLoad();
            return;
          }
          if (m.type === "setTaskDocumentMode") {
            if (m.mode !== "read" && m.mode !== "edit") return;
            policy.switchMode(m.mode);
            session.post(taskDocumentModeMessage(m.mode));
            return;
          }
          if (m.type === "updateTask" && m.patch) {
            try {
              await ws.updateTask(taskId, m.patch);
              // the shared fan-out: re-posts this document, every other open one, the Board and the sidebar.
              this.hooks.onTasksChanged();
            } catch (err) {
              fail(err);
            }
            return;
          }
          if ((m.type === "approvePrototype" || m.type === "rejectPrototype" || m.type === "notePrototype")
            && typeof m.prototypeId === "string" && typeof m.expectUpdatedAt === "string") {
            try {
              const action = m.type === "approvePrototype" ? "approve" : m.type === "rejectPrototype" ? "reject" : "note";
              await ws.reviewPrototype(taskId, {
                prototypeId: m.prototypeId,
                action,
                expectUpdatedAt: m.expectUpdatedAt,
                ...(m.review ? { review: m.review } : {}),
              });
              this.hooks.onTasksChanged();
            } catch (err) {
              fail(err);
            }
          }
        };

        const onMessage = async (message: unknown): Promise<void> => {
          const action = message as Partial<TaskDetailAction>;
          if (action.type === "setTaskDocumentMode" || action.type === "openTaskStudio") {
            await onAction(action);
            return;
          }
          const decoded = decodeStudioMessage<{ type: string; patch?: TaskPatch; dirty?: boolean }>(message, studio?.domainMessageNames ?? []);
          if (decoded.ok && decoded.message && studio) {
            const msg = decoded.message;
            if (msg.type === "ready") { await sendStudioLoad(); return; }
            if (msg.type === "patch" && msg.patch) { policy.receivePatch(msg.patch); return; }
            if (msg.type === "dirty") { policy.receiveDirty(msg.dirty ?? false); return; }
            if (msg.type === "cancel") {
              const leaveEditMode = () => {
                policy.clearDraft();
                // t-3c8f2a — a task that was never saved has nowhere to go back TO. Falling through
                // to read mode is what put "Task t-… never found on disk" on screen after Cancel on
                // a brand-new task. Closing returns the human to the Board they came from, which is
                // already open behind this tab.
                if (!persisted) { this.provisional.delete(session.key); session.close(); return; }
                policy.switchMode("read");
                session.post(taskDocumentModeMessage("read"));
              };
              await confirmDocumentStudioCancel(policy.draft.dirty, async () => {
                if (!policy.draft.patch) return false;
                const result = await studio.save(taskId, policy.draft.patch);
                if (result.status !== "ok") {
                  postStudioError(new Error(result.error.message));
                  return false;
                }
                // t-3c8f2a — the save is what makes the task exist, so it must land BEFORE
                // `leaveEditMode`, which would otherwise read the stale flag and close the tab of a
                // task that was just created.
                persisted = true;
                this.provisional.delete(session.key);
                leaveEditMode();
                this.hooks.onTasksChanged();
                return true;
              }, leaveEditMode);
              return;
            }
            if (msg.type === "save" && policy.draft.patch) {
              const result = await studio.save(taskId, policy.draft.patch);
              if (result.status === "ok") {
                // t-3c8f2a — same reason as the Save-inside-Cancel branch: once written, this key is
                // no longer provisional, or a later Cancel would close a tab whose task exists.
                persisted = true;
                this.provisional.delete(session.key);
                policy.clearDraft();
                policy.switchMode("read");
                this.hooks.onTasksChanged();
                session.post(taskDocumentModeMessage("read"));
              } else postStudioError(new Error(result.error.message));
              return;
            }
            handleTaskStudioDomainMessage(studioTarget!, {
              entityId: taskId,
              post: (m) => { session.post(m); },
            }, msg);
            return;
          }
          await onAction(action);
        };

        return {
          // t-3c8f2a — the mode is announced at the one moment the client is provably listening
          // (its own READY drives this replay), instead of being posted right after `open()` where it
          // races the webview mount. A "New Task" therefore shows its form by derivation, not by luck.
          replay: () => { session.post(taskDocumentModeMessage(policy.mode)); void sendTask(); if (policy.mode === "edit" || policy.draft.dirty) void sendStudioLoad(); },
          resync: () => { session.post(taskDocumentModeMessage(policy.mode)); void sendTask(); if (policy.mode === "edit" || policy.draft.dirty) void sendStudioLoad(); },
          onMessage: (message) => { void onMessage(message); },
          dispose: () => {
            const draft = policy.close();
            // t-3c8f2a — a draft is retained only for a task that EXISTS. Keeping one for a
            // never-saved id would hand it to whatever later opens that id, and clearing the
            // provisional mark here stops a reopened key from starting in edit mode on a stale fact.
            if (persisted && draft) this.drafts.set(session.key, draft);
            else this.drafts.delete(session.key);
            this.provisional.delete(session.key);
          },
        };
      },
    };
  }
}

/**
 * The pre-410 standalone panel's state, translated into this app's. Field renaming only — a compatibility
 * shim with NO UI, which is the one kind `spec.md` allows to survive a cutover. Anything already in the new
 * shape passes through untouched.
 */
function migrateLegacy(state: SectionPanelState | TaskDetailPanelState): SectionPanelState {
  const legacy = state as Partial<TaskDetailPanelState>;
  if (typeof (state as Partial<SectionPanelState>).project === "string") return state as SectionPanelState;
  return {
    schemaVersion: 1,
    view: TASK_DETAIL_VIEW_TYPE,
    project: typeof legacy.wsHash === "string" ? legacy.wsHash : "",
    identity: typeof legacy.taskId === "string" ? legacy.taskId : "",
  };
}

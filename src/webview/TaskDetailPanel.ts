import * as vscode from "vscode";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelState,
  type SectionPanelTarget,
} from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { buildTaskDetailVm, emptyTombstoneVm } from "../cockpit/taskDetailVm.js";
import { taskMessage, taskDetailErrorMessage, type TaskDetailAction } from "./task-detail/messages.js";
import { READY } from "./shared/ready.js";
import type { WorkspaceTaskDetailTarget } from "../shell/TaskDetailTarget.js";
import type { TaskDetailProjectionV1 } from "../runtime-api/taskDetailProjection.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";

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
  ) {
    this.manager = new SectionPanelManager<TaskDetailRefreshKind>(extensionUri, this.configFor(app), workspaceScope);
  }

  /** Open the task's own editor tab, or REVEAL it if this identity is already open. */
  open(wsHash: string, taskId: string): void {
    this.manager.open({ project: wsHash, identity: taskId });
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
      styleFiles: ["codicon.css", "design-system.css", "mermaid-block.css", "task-detail.css"],
      // Both carried forward verbatim from the pre-410 standalone panel this restores — the tab a human
      // used to see for a task is the tab they see again.
      title: (target) => `Task ${target.identity ?? ""}`.trim(),
      iconName: "note",
      // PrototypePreview renders reviewer prototypes in a sandboxed `srcdoc` iframe (spec 335). A security
      // axis, not a conformance posture — see SHELL_EXTENSION_POINTS.
      csp: { frameSrc: "self" },
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
        const type = (message as { type?: unknown } | undefined)?.type;
        return type === READY || type === "requestSnapshot" ? "task" : undefined;
      },
      bind: (session) => {
        const { project, identity } = session.target;
        const taskId = identity ?? "";
        /**
         * The LAST KNOWN good projection for THIS panel. Ported from Control's single slot, which was
         * correct only because Control was a singleton — a document app has as many as it has tabs.
         */
        let lastKnown: TaskDetailProjectionV1 | undefined;

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
            this.hooks.openTaskStudio(ws, taskId);
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

        return {
          replay: () => { void sendTask(); },
          resync: () => { void sendTask(); },
          onMessage: (message) => { void onAction(message as Partial<TaskDetailAction>); },
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

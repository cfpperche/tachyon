import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import type { Workspace } from "../workspace/Workspace.js";
import { buildBoardSnapshot } from "../tasks/boardSnapshot.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { snapshotMessage, taskErrorMessage, type MissionControlAction, type MissionControlVM } from "./mission-control/messages.js";

interface PanelEntry {
  panel: vscode.WebviewPanel;
  ws: Workspace;
  post: () => void | Promise<void>;
}

export const MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS = 250;

type ManagedAgent = Awaited<ReturnType<Workspace["manager"]["list"]>>[number];

interface AgentListResult {
  agents: ManagedAgent[];
  status: MissionControlVM["agentLiveness"];
}

/** Agent liveness enriches the board, but must never gate its task snapshot. */
function boundedAgentList(list: () => Promise<ManagedAgent[]>): Promise<AgentListResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AgentListResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const unavailable = (): void => finish({ agents: [], status: { status: "unavailable" } });
    const timer = setTimeout(unavailable, MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS);

    // Starting from an already-resolved promise also captures a synchronous throw. Both handlers stay
    // attached after timeout so a late rejection cannot become unhandled.
    void Promise.resolve().then(list).then(
      (agents) => finish({ agents, status: { status: "available" } }),
      unavailable,
    );
  });
}

export const MISSION_CONTROL_VIEW_TYPE = "tachyonMissionControl";

export interface MissionControlPanelState {
  schemaVersion: 1;
  view: typeof MISSION_CONTROL_VIEW_TYPE;
  wsHash: string;
}

/**
 * spec 335 — the Mission Control board: a singleton editor-area panel per workspace (HandoffPanel pattern),
 * fed by ONE engine-side board-snapshot pass per push (dueto F4 — every card/chip/spotlight in a push reflects
 * a single consistent filesystem view). All mutations route through `ws.taskStore` directly — the board is
 * engine-side, never MCP. `openTaskDetail`/`openTaskStudio` are injected so this module never imports
 * TaskDetailPanel/TaskStudioPanel directly (kept as independent panel managers, wired in extension.ts).
 */
export class MissionControlPanelManager {
  private readonly panels = new Map<string, PanelEntry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => Workspace[],
    private readonly openTaskDetail: (ws: Workspace, id: string) => void,
    private readonly openTaskStudio: (ws: Workspace, id?: string) => void,
    private readonly onTasksChanged: () => void,
  ) {}

  open(wsHash?: string): void {
    const ws = wsHash === undefined ? this.getWorkspaces()[0] : this.getWorkspaces().find((w) => w.wsHash === wsHash);
    if (!ws) return;
    const key = ws.wsHash;
    const existing = this.panels.get(key);
    if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }

    const panel = vscode.window.createWebviewPanel(
      MISSION_CONTROL_VIEW_TYPE,
      `Mission Control — ${ws.folderName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      // t-b5e6e5 — the native VS Code find widget (Ctrl+F); see notes.md for the validated caveats.
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist", "webview")], retainContextWhenHidden: true, enableFindWidget: true },
    );
    this.attachPanel(panel, ws);
  }

  deserialize(panel: vscode.WebviewPanel, state: MissionControlPanelState): void {
    const ws = this.getWorkspaces().find((w) => w.wsHash === state.wsHash);
    if (!ws) { panel.dispose(); return; }
    this.attachPanel(panel, ws);
  }

  private attachPanel(panel: vscode.WebviewPanel, ws: Workspace): void {
    const key = ws.wsHash;
    const existing = this.panels.get(key);
    if (existing && existing.panel !== panel) existing.panel.dispose();
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    panel.title = `Mission Control — ${ws.folderName}`;
    panel.iconPath = panelIcon(this.extensionUri, "tasklist");
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: `Mission Control — ${ws.folderName}`,
      styles: [uri("codicon.css"), uri("design-system.css"), uri("vscode-theme.css"), uri("mission-control.tailwind.css"), uri("mission-control.css")],
      bundle: uri("mission-control.js"),
      mode: "live",
      persistedState: { schemaVersion: 1, view: MISSION_CONTROL_VIEW_TYPE, wsHash: ws.wsHash } satisfies MissionControlPanelState,
    });

    let entry: PanelEntry;
    const post = async (): Promise<void> => {
      try {
        const current = entry.ws;
        const declaredAgents = Object.keys(current.config?.agents ?? {});
        const declared = new Set(declaredAgents);
        const agentList = await boundedAgentList(() => current.manager.list());
        const liveManagedAgents = agentList.agents.filter((agent) => agent.kind === "agent" && agent.running);
        const liveAdhocAgents = liveManagedAgents
          .filter((agent) => !agent.declared && !declared.has(agent.name))
          .map((agent) => agent.name);
        const vm: MissionControlVM = {
          folder: current.folderName,
          wsHash: current.wsHash,
          workspaces: this.getWorkspaces().map((w) => ({ hash: w.wsHash, folder: w.folderName })),
          agentLiveness: agentList.status,
          snapshot: buildBoardSnapshot({
            store: current.taskStore,
            declaredAgents,
            liveAdhocAgents,
            validationStore: current.validationStore,
            workspaceRoot: current.workspaceRoot,
          }),
        };
        void panel.webview.postMessage(snapshotMessage(vm));
      } catch (err) {
        void panel.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err)));
      }
    };
    entry = { panel, ws, post };
    panel.webview.onDidReceiveMessage((m: Partial<MissionControlAction>) => void this.handleMessage(entry, m));
    panel.onDidDispose(() => {
      for (const [k, value] of this.panels) {
        if (value.panel === panel) this.panels.delete(k);
      }
    });
    this.panels.set(key, entry);
    void post();
  }

  private async handleMessage(entry: PanelEntry, m: Partial<MissionControlAction>): Promise<void> {
    if (!m?.type) return;
    if (m.type === READY || m.type === "requestSnapshot") { void entry.post(); return; }
    if (m.type === "updateTask" && typeof m.id === "string" && m.patch) {
      try {
        await entry.ws.taskStore.update(m.id, m.patch);
        // dogfood round 1 (#1) — the one shared fan-out (injected from extension.ts): re-posts this panel,
        // every other Mission Control/Detail panel, and the sidebar, so no engine-side mutation is board-only.
        this.onTasksChanged();
      } catch (err) {
        void entry.panel.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err), m.id));
      }
      return;
    }
    if (m.type === "reorderLane" && typeof m.status === "string" && Array.isArray(m.orderedIds) && m.expect) {
      try {
        await entry.ws.taskStore.reorderLane(m.status, m.priority, { orderedIds: m.orderedIds, expect: m.expect });
        this.onTasksChanged();
      } catch (err) {
        void entry.panel.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err)));
      }
      return;
    }
    if (m.type === "closeValidation" && typeof m.id === "string" && typeof m.result_note === "string" && m.outcome) {
      try {
        await entry.ws.validationStore.closeRound(m.id, { outcome: m.outcome, result_note: m.result_note });
        this.onTasksChanged();
      } catch (err) {
        void entry.panel.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err), m.id));
      }
      return;
    }
    if (m.type === "openTask" && typeof m.id === "string") {
      this.openTaskDetail(entry.ws, m.id);
      return;
    }
    if (m.type === "copyTaskId" && typeof m.id === "string") {
      await vscode.env.clipboard.writeText(m.id);
      return;
    }
    if (m.type === "switchWorkspace" && typeof m.wsHash === "string") {
      this.switchWorkspace(entry, m.wsHash);
      return;
    }
    if (m.type === "openTaskStudio") {
      this.openTaskStudio(entry.ws, typeof m.id === "string" ? m.id : undefined);
    }
  }

  private switchWorkspace(entry: PanelEntry, wsHash: string): void {
    if (entry.ws.wsHash === wsHash) return;
    const target = this.getWorkspaces().find((w) => w.wsHash === wsHash);
    if (!target) return;
    const existing = this.panels.get(wsHash);
    if (existing && existing.panel !== entry.panel) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    for (const [k, value] of this.panels) {
      if (value.panel === entry.panel) this.panels.delete(k);
    }
    entry.ws = target;
    entry.panel.title = `Mission Control — ${target.folderName}`;
    this.panels.set(target.wsHash, entry);
    entry.post();
  }

  /** Re-post to every open panel — onViewsChanged("tasks") carries no wsHash, so refresh them all (cheap). */
  refreshAll(): void {
    for (const { post } of this.panels.values()) void post();
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}

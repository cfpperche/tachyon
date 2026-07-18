import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import type { MissionControlAgentRow, WorkspaceMissionControlTarget } from "../shell/MissionControlTarget.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { snapshotMessage, taskErrorMessage, type MissionControlAction, type MissionControlVM } from "./mission-control/messages.js";

interface PanelEntry {
  panel: vscode.WebviewPanel;
  ws: WorkspaceMissionControlTarget;
  post: () => void | Promise<void>;
  generation: number;
  agentLists: Map<string, AgentListRequest>;
  disposed: boolean;
}

export const MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS = 250;

type ManagedAgent = MissionControlAgentRow;

interface AgentListResult {
  agents: ManagedAgent[];
  status: MissionControlVM["agentLiveness"];
}

interface AgentListRequest {
  source: Promise<ManagedAgent[]>;
  bounded: Promise<AgentListResult>;
  fellBack: boolean;
  trailing: boolean;
}

/** Agent liveness enriches the board, but must never gate its task snapshot. */
function boundedAgentList(list: () => Promise<ManagedAgent[]>, onFallback: () => void): Promise<AgentListResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: AgentListResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const unavailable = (): void => {
      onFallback();
      finish({ agents: [], status: { status: "unavailable" } });
    };
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
 * a single consistent filesystem view). All mutations route through a typed engine target — the board is
 * engine-side, never MCP. `openTaskDetail`/`openTaskStudio` are injected so this module never imports
 * TaskDetailPanel/TaskStudioPanel directly (kept as independent panel managers, wired in extension.ts).
 */
export class MissionControlPanelManager {
  private readonly panels = new Map<string, PanelEntry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => WorkspaceMissionControlTarget[],
    private readonly openTaskDetail: (ws: WorkspaceMissionControlTarget, id: string) => void,
    private readonly openTaskStudio: (ws: WorkspaceMissionControlTarget, id?: string) => void,
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
      `Board — ${ws.folderName}`,
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

  private attachPanel(panel: vscode.WebviewPanel, ws: WorkspaceMissionControlTarget): void {
    const key = ws.wsHash;
    const existing = this.panels.get(key);
    if (existing && existing.panel !== panel) existing.panel.dispose();
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    panel.title = `Board — ${ws.folderName}`;
    panel.iconPath = panelIcon(this.extensionUri, "tasklist");
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title: `Board — ${ws.folderName}`,
      styles: [uri("codicon.css"), uri("design-system.css"), uri("vscode-theme.css"), uri("mission-control.tailwind.css"), uri("mission-control.css")],
      bundle: uri("mission-control.js"),
      mode: "live",
      persistedState: { schemaVersion: 1, view: MISSION_CONTROL_VIEW_TYPE, wsHash: ws.wsHash } satisfies MissionControlPanelState,
    });

    let entry: PanelEntry;
    const post = async (): Promise<void> => {
      const generation = ++entry.generation;
      const current = entry.ws;
      try {
        const declaredAgents = current.declaredAgentNames();
        const declared = new Set(declaredAgents);
        let request = entry.agentLists.get(current.wsHash);
        if (!request) {
          const source = Promise.resolve().then(() => current.listMissionControlAgents());
          request = { source, bounded: undefined!, fellBack: false, trailing: false };
          request.bounded = boundedAgentList(() => source, () => { request!.fellBack = true; });
          entry.agentLists.set(current.wsHash, request);
          const release = (): void => {
            if (entry.agentLists.get(current.wsHash) !== request) return;
            entry.agentLists.delete(current.wsHash);
            if (request!.trailing && !entry.disposed && entry.ws === current) void entry.post();
          };
          // Keep the underlying request coalesced even after the 250 ms fallback fires. Both handlers are
          // intentional: a manager.list() rejection that arrives after timeout must still be observed.
          void source.then(release, release);
        } else if (request.fellBack) {
          request.trailing = true;
        }
        const agentList = await request.bounded;
        if (entry.disposed || entry.generation !== generation || entry.ws !== current) return;
        const liveManagedAgents = agentList.agents.filter((agent) => agent.kind === "agent" && agent.running);
        const liveAdhocAgents = liveManagedAgents
          .filter((agent) => !agent.declared && !declared.has(agent.name))
          .map((agent) => agent.name);
        const vm: MissionControlVM = {
          folder: current.folderName,
          wsHash: current.wsHash,
          workspaces: this.getWorkspaces().map((w) => ({ hash: w.wsHash, folder: w.folderName })),
          agentLiveness: agentList.status,
          snapshot: await current.boardSnapshot(liveAdhocAgents),
        };
        void panel.webview.postMessage(snapshotMessage(vm));
      } catch (err) {
        if (entry.disposed || entry.generation !== generation || entry.ws !== current) return;
        void panel.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err)));
      }
    };
    entry = { panel, ws, post, generation: 0, agentLists: new Map(), disposed: false };
    panel.webview.onDidReceiveMessage((m: Partial<MissionControlAction>) => void this.handleMessage(entry, m));
    panel.onDidDispose(() => {
      entry.disposed = true;
      entry.generation += 1;
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
        await entry.ws.updateTask(m.id, m.patch);
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
        await entry.ws.reorderLane(m.status, m.priority, { orderedIds: m.orderedIds, expect: m.expect });
        this.onTasksChanged();
      } catch (err) {
        void entry.panel.webview.postMessage(taskErrorMessage(err instanceof Error ? err.message : String(err)));
      }
      return;
    }
    if (m.type === "closeValidation" && typeof m.id === "string" && typeof m.result_note === "string" && m.outcome) {
      try {
        await entry.ws.closeValidation(m.id, { outcome: m.outcome, result_note: m.result_note });
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
    entry.panel.title = `Board — ${target.folderName}`;
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

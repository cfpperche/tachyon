/**
 * Layer-2 first-party agent pane host: WebviewPanel + xterm bundle + tmux attach client.
 * Coexists with layer-1 integrated terminal (`Terminals`); does not replace it.
 */
import * as vscode from "vscode";
import { TmuxAttachClient } from "../presentation/TmuxAttachClient.js";
import { renderWebviewShell } from "./shared/shell.js";
import { panelIcon } from "./shared/panelIcon.js";
import {
  AGENT_PANE_READY,
  AGENT_PANE_VIEW_TYPE,
  isAgentPaneToHost,
  type AgentPanePanelState,
} from "./agent-pane/protocol.js";

export { AGENT_PANE_VIEW_TYPE, type AgentPanePanelState } from "./agent-pane/protocol.js";

export interface AgentPaneOpenArgs {
  agent: string;
  session: string;
  title?: string;
  wsHash?: string;
  /** Open same session in layer-1 integrated terminal (fallback / dual path). */
  openIntegrated: (agent: string, session: string, title?: string) => Promise<void>;
  /** Apply window size to the tmux session (cols × rows). */
  resizeSession: (session: string, cols: number, rows: number) => Promise<void>;
}

interface LivePane {
  panel: vscode.WebviewPanel;
  agent: string;
  session: string;
  title: string;
  attach: TmuxAttachClient | null;
  ready: boolean;
}

export class AgentPanePanelManager {
  private readonly byAgent = new Map<string, LivePane>();
  private disposed = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  dispose(): void {
    this.disposed = true;
    for (const live of this.byAgent.values()) {
      live.attach?.dispose();
      live.panel.dispose();
    }
    this.byAgent.clear();
  }

  deserialize(panel: vscode.WebviewPanel, state: AgentPanePanelState): void {
    // MVP: do not auto-reattach after reload (session may be gone; avoid surprise attach -d).
    panel.dispose();
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Agent pane for '{0}' was open before reload — reopen via Tachyon: Open Agent Pane.", state.agent),
    );
  }

  async open(args: AgentPaneOpenArgs): Promise<void> {
    if (this.disposed) return;

    const existing = this.byAgent.get(args.agent);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active, false);
      return;
    }

    const title = args.title ?? args.agent;
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      AGENT_PANE_VIEW_TYPE,
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [root],
        enableFindWidget: true,
      },
    );
    panel.iconPath = panelIcon(this.extensionUri, "terminal-tmux");

    const live: LivePane = {
      panel,
      agent: args.agent,
      session: args.session,
      title,
      attach: null,
      ready: false,
    };
    this.byAgent.set(args.agent, live);

    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title,
      styles: [uri("codicon.css"), uri("design-system.css"), uri("xterm.css"), uri("agent-pane.css")],
      bundle: uri("agent-pane.js"),
      mode: "live",
      persistedState: {
        schemaVersion: 1,
        view: AGENT_PANE_VIEW_TYPE,
        agent: args.agent,
        session: args.session,
        title,
        ...(args.wsHash !== undefined ? { wsHash: args.wsHash } : {}),
      } satisfies AgentPanePanelState,
    });

    const post = (msg: unknown) => {
      void panel.webview.postMessage(msg);
    };

    const startAttach = (cols: number, rows: number) => {
      live.attach?.dispose();
      const attach = new TmuxAttachClient({
        onData: (chunk) => post({ type: "agent-pane/data", data: chunk }),
        onExit: (code, signal) => {
          live.attach = null;
          post({
            type: "agent-pane/exit",
            code,
            signal: signal ?? null,
          });
          post({ type: "agent-pane/status", status: "detached" });
        },
        onError: (err) => {
          post({ type: "agent-pane/status", status: `error: ${err.message}` });
          void vscode.window.showErrorMessage(
            vscode.l10n.t("Agent pane attach failed: {0}", err.message),
          );
        },
      });
      live.attach = attach;
      try {
        attach.start({
          session: args.session,
          cols,
          rows,
          exclusive: true,
        });
        post({ type: "agent-pane/status", status: "attached" });
        void args.resizeSession(args.session, cols, rows).catch(() => {
          /* best-effort */
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        post({ type: "agent-pane/status", status: `error: ${message}` });
        void vscode.window.showErrorMessage(vscode.l10n.t("Agent pane attach failed: {0}", message));
      }
    };

    panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!isAgentPaneToHost(raw)) return;
      if (raw.type === AGENT_PANE_READY) {
        live.ready = true;
        post({
          type: "agent-pane/init",
          agent: args.agent,
          session: args.session,
          title,
          status: "connecting…",
        });
        // Default size until first resize from the webview fit addon
        startAttach(120, 40);
        return;
      }
      if (raw.type === "agent-pane/input") {
        live.attach?.write(raw.data);
        return;
      }
      if (raw.type === "agent-pane/resize") {
        void args.resizeSession(args.session, raw.cols, raw.rows).catch(() => {
          /* best-effort */
        });
        return;
      }
      if (raw.type === "agent-pane/open-integrated") {
        void args.openIntegrated(args.agent, args.session, args.title).catch((err) => {
          void vscode.window.showErrorMessage(
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    });

    panel.onDidDispose(() => {
      live.attach?.dispose();
      this.byAgent.delete(args.agent);
    });
  }
}

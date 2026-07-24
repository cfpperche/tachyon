/**
 * Layer-2 first-party agent pane host: WebviewPanel + xterm bundle + node-pty tmux attach.
 * Coexists with layer-1 integrated terminal (`Terminals`); does not replace it.
 */
import * as vscode from "vscode";
import { TmuxAttachClient } from "../presentation/TmuxAttachClient.js";
import { resolveAgentPaneFontMetrics } from "../presentation/agentPaneFont.js";
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
  /** Apply window size to the tmux session (cols × rows) — backup when PTY resize is not enough. */
  resizeSession: (session: string, cols: number, rows: number) => Promise<void>;
}

interface LivePane {
  panel: vscode.WebviewPanel;
  agent: string;
  session: string;
  title: string;
  attach: TmuxAttachClient | null;
  ready: boolean;
  /** Last FitAddon size — used to start attach only once we know geometry. */
  lastCols: number;
  lastRows: number;
  started: boolean;
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
    // Same glyph as sidebar openPane action (codicon "terminal")
    panel.iconPath = panelIcon(this.extensionUri, "terminal");

    const live: LivePane = {
      panel,
      agent: args.agent,
      session: args.session,
      title,
      attach: null,
      ready: false,
      lastCols: 0,
      lastRows: 0,
      started: false,
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
      if (live.started && live.attach?.alive) {
        live.attach.resize(cols, rows);
        void args.resizeSession(args.session, cols, rows).catch(() => {
          /* best-effort */
        });
        return;
      }

      live.attach?.dispose();
      const attach = new TmuxAttachClient({
        onData: (chunk) => post({ type: "agent-pane/data", data: chunk }),
        onExit: (code, signal) => {
          live.attach = null;
          live.started = false;
          post({
            type: "agent-pane/exit",
            code,
            signal: signal !== null && signal !== undefined ? String(signal) : null,
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
        // exclusive -d matches Terminals.open so we own geometry like the integrated terminal.
        attach.start({
          session: args.session,
          cols,
          rows,
          exclusive: true,
        });
        live.started = true;
        post({ type: "agent-pane/status", status: "attached" });
        void args.resizeSession(args.session, cols, rows).catch(() => {
          /* best-effort */
        });
      } catch (err) {
        live.started = false;
        const message = err instanceof Error ? err.message : String(err);
        post({ type: "agent-pane/status", status: `error: ${message}` });
        void vscode.window.showErrorMessage(vscode.l10n.t("Agent pane attach failed: {0}", message));
      }
    };

    /**
     * Start PTY only after the webview measured a real grid (post-font fit).
     * Starting at a placeholder 120×40 then resizing makes full-screen TUIs
     * draw status bars off-screen and never fully recover.
     */
    const maybeStart = () => {
      if (!live.ready) return;
      if (live.lastCols < 2 || live.lastRows < 1) return;
      startAttach(live.lastCols, live.lastRows);
    };

    panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!isAgentPaneToHost(raw)) return;
      if (raw.type === AGENT_PANE_READY) {
        live.ready = true;
        // Match integrated terminal typography (xterm cannot use CSS vars for measurement).
        const font = resolveAgentPaneFontMetrics(
          vscode.workspace.getConfiguration("terminal.integrated"),
          vscode.workspace.getConfiguration("editor"),
        );
        post({
          type: "agent-pane/init",
          agent: args.agent,
          session: args.session,
          title,
          status: "connecting…",
          font,
        });
        // Do NOT attach yet — wait for first agent-pane/resize with measured cols×rows.
        return;
      }
      if (raw.type === "agent-pane/input") {
        live.attach?.write(raw.data);
        return;
      }
      if (raw.type === "agent-pane/resize") {
        live.lastCols = raw.cols;
        live.lastRows = raw.rows;
        if (live.started && live.attach?.alive) {
          live.attach.resize(raw.cols, raw.rows);
          void args.resizeSession(args.session, raw.cols, raw.rows).catch(() => {
            /* best-effort */
          });
        } else {
          maybeStart();
        }
      }
    });

    panel.onDidDispose(() => {
      live.attach?.dispose();
      this.byAgent.delete(args.agent);
    });
  }
}

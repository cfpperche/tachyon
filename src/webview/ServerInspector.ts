import * as vscode from "vscode";
import { panelIcon } from "./shared/panelIcon.js";
import { buildInspectorModel, type InspectorModel, type TmuxServerSnapshot } from "../inspector/model.js";
import type { PaneSnapshot } from "../tmux/TmuxService.js";
import { renderWebviewShell } from "./shared/shell.js";
import { READY } from "./shared/ready.js";
import { initMessage, modelMessage, captureMessage, type InspectorStrings, type InspectorAction } from "./inspector/messages.js";
import { showNotification } from "../workspace/NotificationService.js";

export const SERVER_INSPECTOR_VIEW_TYPE = "tachyonServerInspector";

export interface ServerInspectorPanelState {
  schemaVersion: 1;
  view: typeof SERVER_INSPECTOR_VIEW_TYPE;
}

/**
 * The tmux Server Inspector — a read-only editor webview over the dedicated
 * `tmux -L tachyon` socket. It shows every Tachyon-owned session grouped by
 * workspace then kind (agent/terminal, command, runbook, engine anchor), each
 * with its live/dead+exit-code state, pid, and running command. Three direct
 * actions per session: Capture (last lines of pane output) and Kill.
 *
 * Cross-workspace by design — the socket is shared, so the inspector surfaces
 * orphans and other open folders' sessions too. Thin like the Agent Studio:
 * all data shaping is pure (inspector/model + classify, unit-tested); the panel
 * renders a posted model and relays capture/kill/refresh messages. Theming via
 * --vscode-* tokens + the bundled codicon font; strings localized extension-side.
 */

export interface InspectorDeps {
  extensionUri: vscode.Uri;
  /** Raw pane snapshot for the whole Tachyon namespace on the socket. */
  snapshot: () => Promise<PaneSnapshot[]>;
  /** Current wsHash -> folder name for open workspaces (for group labels). */
  folderByHash: () => Map<string, string>;
  /** Per-session CPU activity over the last interval (busy=true). Empty off-Linux. */
  cpuBusy: (rows: PaneSnapshot[]) => Map<string, boolean>;
  /** Dedicated Tachyon socket health and best-effort process diagnostics. */
  serverHealth: () => Promise<TmuxServerSnapshot>;
  /** Last lines of a session's pane output. */
  capture: (session: string) => Promise<string>;
  /** Open the session in an editor terminal (attach). */
  open: (session: string) => void;
  /** Kill a session by exact name. */
  kill: (session: string) => Promise<void>;
  /** Reap all dead-pane sessions; returns how many were killed (after a confirm). */
  reapDead: () => Promise<number>;
  /** Reap all sessions owned by closed/foreign workspaces; returns how many (after a confirm). */
  reapOrphans: () => Promise<number>;
}

function strings(): InspectorStrings {
  const t = vscode.l10n.t;
  return {
    title: t("tmux Server Inspector"),
    subtitle: t("Live view of the dedicated tachyon socket — every session Tachyon owns."),
    refresh: t("Refresh"),
    auto: t("Auto-refresh"),
    empty: t("No Tachyon sessions on the socket. Start an agent, command, or runbook to populate the server."),
    summary: t("{0} sessions · {1} live", "{0}", "{1}"),
    foreignNote: t("not an open workspace — orphaned or owned by another window"),
    pid: t("pid"),
    live: t("live"),
    dead: t("exited"),
    exit: t("exit {0}", "{0}"),
    busy: t("busy"),
    idle: t("idle"),
    open: t("Open"),
    capture: t("Capture"),
    kill: t("Kill"),
    reapDead: t("Kill {0} dead", "{0}"),
    reapOrphans: t("Reap {0} orphaned", "{0}"),
    killConfirm: t("Kill session {0}? This stops the process and removes the pane.", "{0}"),
    kindSession: t("Agents & terminals"),
    kindCommand: t("Commands"),
    kindRunbook: t("Runbook steps"),
    kindAnchor: t("Engine internals"),
    kindUnknown: t("Other"),
    captureEmpty: t("(no output)"),
    ageSeconds: t("{0}s", "{0}"),
    ageMinutes: t("{0}m", "{0}"),
    ageHours: t("{0}h", "{0}"),
    ageDays: t("{0}d", "{0}"),
    overview: t("Overview"), server: t("Server"), all: t("All"), search: t("Search sessions, commands, or labels"),
    workspace: t("Workspace"), status: t("Status"), kind: t("Kind"), cpu: t("CPU"), details: t("Details"),
    fullName: t("Full session name"), hash: t("Workspace hash"), command: t("Current command"), startCommand: t("Start command"), uptime: t("Uptime"),
    total: t("Total"), orphaned: t("Orphaned"), socket: t("Socket"), path: t("Path"), health: t("Health"), version: t("tmux version"),
    serverPids: t("Server PIDs"), diagnostics: t("Process diagnostics"), noDiagnostics: t("No process diagnostics available."),
    refreshCapture: t("Refresh capture"), close: t("Close"), bulkActions: t("Bulk actions"),
  };
}

let panel: vscode.WebviewPanel | undefined;

export async function openServerInspector(deps: InspectorDeps, revivedPanel?: vscode.WebviewPanel): Promise<void> {
  const s = strings();
  if (panel && !revivedPanel) {
    panel.reveal(vscode.ViewColumn.Active);
  } else {
    panel = revivedPanel ?? vscode.window.createWebviewPanel(SERVER_INSPECTOR_VIEW_TYPE, s.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, "dist", "webview")],
    });
    panel.title = s.title;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, "dist", "webview")],
    };
    panel.iconPath = panelIcon(deps.extensionUri, "terminal-tmux"); // spec 282 — contextual editor-tab icon
    panel.onDidDispose(() => {
      panel = undefined;
    });
  }
  const live = panel;

  const sendModel = async () => {
    let model: InspectorModel;
    try {
      const [snap, server] = await Promise.all([deps.snapshot(), deps.serverHealth()]);
      const busy = deps.cpuBusy(snap);
      model = buildInspectorModel(snap, deps.folderByHash(), busy, server);
    } catch {
      model = { groups: [], totalSessions: 0, liveSessions: 0, deadSessions: 0, orphanSessions: 0, busySessions: 0 };
    }
    if (panel === live) live.webview.postMessage(modelMessage(model));
  };

  live.webview.onDidReceiveMessage(async (msg: { type: InspectorAction["type"]; session?: string }) => {
    if (panel !== live) return;
    switch (msg.type) {
      case READY:
        live.webview.postMessage(initMessage(s));
        await sendModel();
        return;
      case "refresh":
        await sendModel();
        return;
      case "open":
        if (msg.session) deps.open(msg.session);
        return;
      case "reapDead": {
        await deps.reapDead();
        await sendModel();
        return;
      }
      case "reapOrphans": {
        await deps.reapOrphans();
        await sendModel();
        return;
      }
      case "capture": {
        if (!msg.session) return;
        let text = "";
        try {
          text = await deps.capture(msg.session);
        } catch {
          text = "";
        }
        live.webview.postMessage(captureMessage(msg.session, text));
        return;
      }
      case "kill": {
        if (!msg.session) return;
        const ok = await showNotification(
          vscode.l10n.t("Kill session {0}? This stops the process and removes the pane.", msg.session),
          "warn",
          [vscode.l10n.t("Kill")],
          { modal: true },
        );
        if (ok) {
          try {
            await deps.kill(msg.session);
          } catch {
            /* already gone */
          }
          await sendModel();
        }
        return;
      }
    }
  });

  const uri = (f: string): string => live.webview.asWebviewUri(vscode.Uri.joinPath(deps.extensionUri, "dist", "webview", f)).toString();
  live.webview.html = renderWebviewShell({
    cspSource: live.webview.cspSource,
    title: s.title,
    styles: [uri("codicon.css"), uri("design-system.css"), uri("inspector.css")],
    bundle: uri("inspector.js"),
    mode: "live",
    persistedState: { schemaVersion: 1, view: SERVER_INSPECTOR_VIEW_TYPE } satisfies ServerInspectorPanelState,
  });
}

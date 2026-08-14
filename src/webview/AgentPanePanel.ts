/**
 * Layer-2 first-party agent pane host: WebviewPanel + xterm bundle + node-pty tmux attach.
 * Coexists with layer-1 integrated terminal (`Terminals`); does not replace it.
 * Slice 1: identity strip + stage/submit bar → 381-style tmux delivery.
 * Slice 2: inject markers (webview) + selection → Pin.
 */
import * as vscode from "vscode";
import { TmuxAttachClient, type PtySpawn } from "../presentation/TmuxAttachClient.js";
import type { SessionViewportRegistry } from "../presentation/sessionViewport.js";
import { probeForeignClients, type SessionClientInfo } from "@tachyon/shared/presentation/foreignTmuxClient.js";
import { resolveAgentPaneFontMetrics } from "../presentation/agentPaneFont.js";
import { renderWebviewShell } from "./shared/shell.js";
import { panelIcon } from "./shared/panelIcon.js";
import {
  AGENT_PANE_READY,
  AGENT_PANE_VIEW_TYPE,
  isAgentPaneToHost,
  pinTitleFromSelection,
  type AgentPanePanelState,
  type AgentPanePickerItem,
  type AgentPaneToHost,
} from "./agent-pane/protocol.js";

export { AGENT_PANE_VIEW_TYPE, type AgentPanePanelState } from "./agent-pane/protocol.js";

export interface AgentPaneOpenArgs {
  agent: string;
  session: string;
  title?: string;
  wsHash?: string;
  /** Apply window size to the tmux session (cols × rows) — backup when PTY resize is not enough. */
  resizeSession: (session: string, cols: number, rows: number) => Promise<void>;
  /**
   * Deliver freeform stage/submit into the agent session (same tmux path as prompt.inject).
   * `submit=true` → paste + Enter; false → stage only.
   */
  deliverText: (session: string, text: string, submit: boolean) => Promise<void>;
  /**
   * Open 381 prompt-template picker for this agent.
   * Return true when a template was staged/submitted (not cancelled).
   */
  openTemplateInject: (
    agent: string,
    choose: (request: { title: string; placeholder?: string; items: AgentPanePickerItem[] }) => Promise<string | undefined>,
  ) => Promise<boolean>;
  /** Create a project pin from selected terminal text. */
  createPinFromSelection: (text: string, agent: string) => Promise<{ id: string }>;
  /** Is the tmux session still running? Answers "did I lose the view or the work?" (t-feaaea). */
  sessionAlive?: (session: string) => Promise<boolean>;
  /**
   * t-edbe36 — list tmux clients on this session (name + size). Measurement only: the pane
   * never detaches or kills a client it did not spawn (a human shell attach is not ours).
   */
  listClients?: (session: string) => Promise<SessionClientInfo[]>;
  /** Test seam mirroring `TmuxAttachClientOptions.ptySpawn`; production loads node-pty. */
  ptySpawn?: PtySpawn;
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
  /**
   * The pane held a client and lost it (handoff or clean exit). It must then stay detached until
   * the human presses Reattach — otherwise the next resize event silently re-claims the session and
   * closes the terminal they just opened, ping-ponging the two viewports (t-feaaea).
   */
  detached: boolean;
  /** t-edbe36 — last co-attach notice key so we do not spam the webview on every poll. */
  foreignKey: string | null;
  /** t-edbe36 — poll handle while attached; cleared on detach/dispose. */
  foreignTimer: ReturnType<typeof setInterval> | null;
  /**
   * SDD 485 B1 — does the pane WANT the co-attach poll running (attached, not handed off)? Kept
   * apart from `foreignTimer` because hiding the tab clears the timer without changing the intent:
   * the poll must come back on reveal, and must NOT come back after a detach.
   */
  foreignWatch: boolean;
}

export class AgentPanePanelManager {
  private readonly byAgent = new Map<string, LivePane>();
  private disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** t-feaaea — one exclusive tmux client per session, shared with layer-1 `Terminals`. */
    private readonly viewports?: SessionViewportRegistry,
  ) {}

  dispose(): void {
    this.disposed = true;
    for (const live of this.byAgent.values()) {
      if (live.foreignTimer !== null) {
        clearInterval(live.foreignTimer);
        live.foreignTimer = null;
      }
      live.attach?.dispose();
      this.viewports?.release(live.session, "pane");
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
      detached: false,
      foreignKey: null,
      foreignTimer: null,
      foreignWatch: false,
    };
    this.byAgent.set(args.agent, live);

    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title,
      // Shared tokens + components are safe; only faces.css is omitted because Tachyon Mono changes xterm metrics.
      styles: [uri("codicon.css"), uri("xterm.css"), uri("tokens.css"), uri("design-system.css"), uri("quick-picker.css"), uri("agent-pane.css")],
      bundle: uri("agent-pane.js"),
      mode: "live",
      surface: AGENT_PANE_VIEW_TYPE,
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

    /** Clears the timer without forgetting that the pane WANTS to be watching (see `live.foreignWatch`). */
    const clearForeignTimer = () => {
      if (live.foreignTimer !== null) {
        clearInterval(live.foreignTimer);
        live.foreignTimer = null;
      }
    };

    const stopForeignWatch = () => {
      live.foreignWatch = false;
      clearForeignTimer();
    };

    const clearForeignNotice = (restoreStatus: boolean) => {
      if (live.foreignKey === null) return;
      live.foreignKey = null;
      post({ type: "agent-pane/co-attach", present: false });
      if (restoreStatus && live.started && live.attach?.alive && !live.detached) {
        post({ type: "agent-pane/status", status: "attached" });
      }
    };

    /**
     * t-edbe36 — measure list-clients while we own the session. Our viewports never co-exist
     * (SessionViewportRegistry), so any extra client is foreign. Explain only — never detach it.
     */
    const probeForeign = async () => {
      if (!args.listClients) return;
      if (!live.started || !live.attach?.alive || live.detached) return;
      // Registry is the "ours" side: if something else owns the session we already handed off.
      if (this.viewports && this.viewports.ownerOf(args.session) !== "pane") return;
      let clients: SessionClientInfo[];
      try {
        clients = await args.listClients(args.session);
      } catch {
        return;
      }
      if (!live.started || !live.attach?.alive || live.detached) return;
      const probe = probeForeignClients(clients, { cols: live.lastCols, rows: live.lastRows });
      if (probe.kind === "foreign") {
        const key = `${probe.width}x${probe.height}:${probe.extraCount}`;
        if (live.foreignKey === key) return;
        live.foreignKey = key;
        post({
          type: "agent-pane/status",
          status: vscode.l10n.t(
            "another tmux client ({0}×{1}) is attached — temporary; work is safe",
            probe.width,
            probe.height,
          ),
        });
        post({
          type: "agent-pane/co-attach",
          present: true,
          width: probe.width,
          height: probe.height,
        });
        return;
      }
      if (probe.kind === "uncertain") {
        // Do not invent a foreign client; leave any prior notice alone until we can measure again.
        return;
      }
      clearForeignNotice(true);
    };

    /**
     * SDD 485 B1 — the pane's one piece of periodic WORK: `tmux list-clients` every 2s, per open
     * pane, forever. It exists to explain a co-attached client on screen, so a pane nobody is
     * looking at has nothing to explain and the poll is pure cost. Hidden ⇒ the timer is cleared and
     * no `list-clients` runs; revealed ⇒ it restarts with an immediate probe.
     *
     * The catch-up here needs no journal and has no delta branch: `probeForeign` reads the CURRENT
     * client list, so one probe on reveal is a full resync by construction. What was suppressed is
     * only the notice ABOUT that state, and the state is re-derived, never replayed.
     */
    const armForeignWatch = () => {
      clearForeignTimer();
      if (!live.foreignWatch || !args.listClients || !panel.visible) return;
      // Resize catches local geometry changes; a short poll catches a shell attach that does not
      // resize our webview (the foreign client is smaller — we just get · padding).
      live.foreignTimer = setInterval(() => {
        void probeForeign();
      }, 2000);
      void probeForeign();
    };

    const startForeignWatch = () => {
      live.foreignWatch = true;
      armForeignWatch();
    };

    panel.onDidChangeViewState(() => {
      if (panel.visible) armForeignWatch();
      else clearForeignTimer();
    });

    /**
     * Another viewport (the integrated terminal) is taking this session — let go of our tmux
     * client BEFORE it attaches. Deliberate handoff, so the human sees "the terminal has it",
     * not a redraw full of `·` followed by a client eviction (t-feaaea).
     */
    const releaseToTerminal = () => {
      if (!live.attach && !live.started) return;
      stopForeignWatch();
      clearForeignNotice(false);
      live.attach?.dispose();
      live.attach = null;
      live.started = false;
      live.detached = true;
      post({
        type: "agent-pane/status",
        status: vscode.l10n.t("detached — the integrated terminal has this session"),
      });
      post({ type: "agent-pane/attach-state", state: "detached", reason: "handoff", sessionAlive: true });
    };

    const startAttach = (cols: number, rows: number) => {
      if (live.started && live.attach?.alive) {
        live.attach.resize(cols, rows);
        void args.resizeSession(args.session, cols, rows).catch(() => {
          /* best-effort */
        });
        void probeForeign();
        return;
      }

      // Take the session before spawning a client: any layer-1 terminal on it closes first, so the
      // two clients never coexist — that overlap is what paints the dot fill (t-feaaea).
      this.viewports?.claim(args.session, "pane", releaseToTerminal);

      live.attach?.dispose();
      const attach = new TmuxAttachClient({
        onData: (chunk) => post({ type: "agent-pane/data", data: chunk }),
        onExit: (code, signal) => {
          stopForeignWatch();
          clearForeignNotice(false);
          live.attach = null;
          live.started = false;
          live.detached = true;
          post({
            type: "agent-pane/exit",
            code,
            signal: signal !== null && signal !== undefined ? String(signal) : null,
          });
          // "Is the work gone, or only the window onto it?" — the pane must answer that before it
          // asks the human to do anything. A clean detach leaves the agent running.
          void (async () => {
            let alive = false;
            try {
              alive = args.sessionAlive ? await args.sessionAlive(args.session) : false;
            } catch {
              alive = false;
            }
            post({
              type: "agent-pane/status",
              status: alive
                ? vscode.l10n.t("detached — the agent session is still running")
                : vscode.l10n.t("detached — the agent session ended"),
            });
            post({ type: "agent-pane/attach-state", state: "detached", reason: "ended", sessionAlive: alive });
          })();
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
          ...(args.ptySpawn ? { ptySpawn: args.ptySpawn } : {}),
        });
        live.started = true;
        live.detached = false;
        post({ type: "agent-pane/status", status: "attached" });
        post({ type: "agent-pane/attach-state", state: "attached" });
        void args.resizeSession(args.session, cols, rows).catch(() => {
          /* best-effort */
        });
        startForeignWatch();
      } catch (err) {
        live.started = false;
        const message = err instanceof Error ? err.message : String(err);
        post({ type: "agent-pane/status", status: `error: ${message}` });
        void vscode.window.showErrorMessage(vscode.l10n.t("Agent pane attach failed: {0}", message));
      }
    };

    const maybeStart = () => {
      if (!live.ready) return;
      // Never re-claim the session on a mere resize — reattach is a human decision (t-feaaea).
      if (live.detached) return;
      if (live.lastCols < 2 || live.lastRows < 1) return;
      startAttach(live.lastCols, live.lastRows);
    };

    const handleDelivery = async (mode: "stage" | "submit", text: string) => {
      const trimmed = text.trimEnd();
      if (!trimmed) {
        post({
          type: "agent-pane/delivery",
          ok: false,
          mode,
          message: vscode.l10n.t("Nothing to {0}.", mode),
        });
        return;
      }
      try {
        await args.deliverText(args.session, text, mode === "submit");
        post({
          type: "agent-pane/delivery",
          ok: true,
          mode,
          message: mode === "submit"
            ? vscode.l10n.t("Submitted to '{0}'.", args.agent)
            : vscode.l10n.t("Staged into '{0}' (not submitted).", args.agent),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        post({ type: "agent-pane/delivery", ok: false, mode, message });
        void vscode.window.showWarningMessage(message);
      }
    };

    let pickerSequence = 0;
    let pendingPicker: { requestId: string; resolve: (selectedId: string | undefined) => void } | undefined;
    const chooseInPane = (request: { title: string; placeholder?: string; items: AgentPanePickerItem[] }) => {
      pendingPicker?.resolve(undefined);
      const requestId = `picker-${++pickerSequence}`;
      return new Promise<string | undefined>((resolve) => {
        pendingPicker = { requestId, resolve };
        post({ type: "agent-pane/picker", requestId, ...request });
      });
    };

    panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!isAgentPaneToHost(raw)) return;
      const msg: AgentPaneToHost = raw;
      if (msg.type === AGENT_PANE_READY) {
        live.ready = true;
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
        return;
      }
      if (msg.type === "agent-pane/input") {
        live.attach?.write(msg.data);
        return;
      }
      if (msg.type === "agent-pane/resize") {
        live.lastCols = msg.cols;
        live.lastRows = msg.rows;
        if (live.started && live.attach?.alive) {
          live.attach.resize(msg.cols, msg.rows);
          void args.resizeSession(args.session, msg.cols, msg.rows).catch(() => {
            /* best-effort */
          });
          // Geometry change is when the · fill appears/disappears — re-measure clients.
          void probeForeign();
        } else {
          maybeStart();
        }
        return;
      }
      if (msg.type === "agent-pane/reattach") {
        // The pane lost only its client; the session kept running. Reclaiming it here (rather than
        // making the human reopen the pane) is the whole point of t-feaaea.
        if (live.lastCols < 2 || live.lastRows < 1) return;
        live.detached = false;
        startAttach(live.lastCols, live.lastRows);
        return;
      }
      if (msg.type === "agent-pane/stage") {
        void handleDelivery("stage", msg.text);
        return;
      }
      if (msg.type === "agent-pane/submit") {
        void handleDelivery("submit", msg.text);
        return;
      }
      if (msg.type === "agent-pane/picker-result") {
        if (pendingPicker?.requestId !== msg.requestId) return;
        const { resolve } = pendingPicker;
        pendingPicker = undefined;
        resolve(msg.selectedId);
        return;
      }
      if (msg.type === "agent-pane/inject-template") {
        void args.openTemplateInject(args.agent, chooseInPane).then((ok) => {
          if (ok) post({ type: "agent-pane/mark", kind: "template" });
        }).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showWarningMessage(message);
        });
        return;
      }
      if (msg.type === "agent-pane/pin-selection") {
        void (async () => {
          try {
            const title = pinTitleFromSelection(msg.text, args.agent);
            if (!title) {
              post({ type: "agent-pane/pin-result", ok: false, message: vscode.l10n.t("Nothing selected.") });
              return;
            }
            const pin = await args.createPinFromSelection(msg.text, args.agent);
            post({
              type: "agent-pane/pin-result",
              ok: true,
              message: vscode.l10n.t("Pinned as {0}.", pin.id),
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            post({ type: "agent-pane/pin-result", ok: false, message });
            void vscode.window.showWarningMessage(message);
          }
        })();
      }
    });

    panel.onDidDispose(() => {
      pendingPicker?.resolve(undefined);
      pendingPicker = undefined;
      stopForeignWatch();
      live.attach?.dispose();
      this.viewports?.release(args.session, "pane");
      this.byAgent.delete(args.agent);
    });
  }
}

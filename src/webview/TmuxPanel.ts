import * as vscode from "vscode";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelSession, type SectionPanelState } from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { buildInspectorModel, type InspectorModel } from "../inspector/model.js";
import { READY, captureMessage, initMessage, modelMessage, type InspectorAction, type InspectorScope, type InspectorStrings } from "./inspector/messages.js";
import type { InspectorDeps } from "./ServerInspector.js";
import { showNotification } from "../workspace/NotificationService.js";

/**
 * The viewType, and it is the RETIRED one on purpose.
 *
 * SDD 410 Phase B #5 retired the standalone Server Inspector panel to a serializer-only tombstone whose
 * persisted state was `{schemaVersion: 1, view}` — no other fields, because the surface had nothing to be
 * scoped by. That is EXACTLY what a `window` app persists (`SectionPanelManager.panelStateFor` omits
 * `project` when the cardinality has none), so the tombstone's state is not a legacy shape to migrate: it
 * is already a valid state for this app. A pre-410 panel is therefore REVIVED into the tab it was, with no
 * compatibility shim at all and no window in which a human sees one tab close and another open.
 *
 * C4 reused `tachyonTaskDetail` for a weaker version of this argument (its tombstone still needed two
 * fields renamed); C5 could NOT reuse the retired Board viewType, because that tombstone is a live redirect
 * carrying an incompatible `{wsHash}`. This one is the clean case, and it is the cardinality that makes it
 * clean.
 */
export const TMUX_VIEW_TYPE = "tachyonServerInspector";

/** the one invalidation kind this app knows: "the session list you are showing may be stale". */
type TmuxRefreshKind = "tmux";

/**
 * SDD 485 D1 — the tmux Server Inspector as a standalone `window` app: ONE editor tab for the whole
 * window, so it can be read beside the agent terminal whose session it is about.
 *
 * ## Why `window` and not `dashboard`
 *
 * A dashboard is one panel per section PER PROJECT, and this surface has no project. Three facts say so,
 * and they were true before this migration rather than arranged for it:
 *
 *  - the socket is one per user (`tmux -L tachyon`), shared by every workspace in the window. The manifest
 *    already recorded it when 410 retired the standalone panel: "no per-workspace scoping needed — the
 *    tmux socket is cross-workspace by design";
 *  - the model's universe is WIDER than the attached workspaces. `buildInspectorModel` emits `foreign`
 *    groups for sessions owned by closed folders and by other windows — rows no project key could name,
 *    and the ones the Reap-orphans action exists for;
 *  - the screen already has its own Workspace filter with an "all" option, and
 *    `controlWorkspaceScope.test.ts` protects it deliberately: "tmux keeps its Workspace filter — its
 *    universe includes closed and other-workspace sessions".
 *
 * Under `dashboard`, opening tmux with two projects attached would open TWO panels showing byte-identical
 * content read from one server. The rejected alternative — dashboard with a constant project — produces
 * one panel and a key that lies; see `SectionAppCardinality` and notes.md for why that was not enough.
 *
 * ## What this file owns, and what it does not
 *
 * The key, reveal-on-reopen, the shared shell, the persisted state, revive, and the `PanelWorkGate` that
 * makes a hidden panel do no work and a revealed one never stale all belong to `SectionPanelManager`. What
 * is left here is the domain: how to build the model from the socket, and what its seven actions mean —
 * the same seven, doing the same things, that `Cockpit.ts` did while tmux was a Control section.
 *
 * ## Hidden work
 *
 * Two doors reach this app and both are gated by construction: the client's own auto-refresh poll (claimed
 * by `tmuxRefreshKind`, so the gate answers it host-side whatever timer a client version runs — Phase B's
 * loudest finding) and every `session.post`. There is no fan-out door: nothing in the extension host emits
 * a `views-changed` for tmux, and this migration does not invent one. The socket is polled, not watched,
 * and that was true inside Control too.
 */
/**
 * t-6b5dea — the read side of `ControlWorkspaceScope`, and only the read side.
 *
 * This app is a READER of the window scope, never a writer: the sidebar owns that control (asserted by
 * `controlWorkspaceScope.test.ts` — exactly one selector, and it is not this screen's). Depending on the
 * one property it reads rather than on the class says so in the type, and lets the tests hand it a value
 * without a `Memento`.
 */
export interface WorkspaceScopeReader {
  readonly current: string | undefined;
}

export class TmuxPanelManager {
  private readonly manager: SectionPanelManager<TmuxRefreshKind>;

  constructor(
    extensionUri: vscode.Uri,
    private readonly deps: InspectorDeps,
    private readonly scope: WorkspaceScopeReader | undefined,
    app: WebviewAppEntry = webviewApp("inspector"),
  ) {
    this.manager = new SectionPanelManager<TmuxRefreshKind>(extensionUri, this.configFor(app));
  }

  /** Open the tmux tab, or REVEAL the one already open. There is only ever one. */
  open(): void {
    this.manager.open({});
  }

  /** the fan-out door, for a caller that has one. Returns how many panels did work — 0 or 1. */
  refresh(): number {
    return this.manager.refresh("tmux");
  }

  /** the upstream event cursor expired: a hidden panel rebuilds instead of replaying on reveal. */
  markSourceResync(): void {
    this.manager.markSourceResync();
  }

  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void {
    this.manager.deserialize(panel, state);
  }

  get openKeys(): string[] {
    return this.manager.openKeys;
  }

  dispose(): void {
    this.manager.dispose();
  }

  private configFor(app: WebviewAppEntry): SectionAppConfig<TmuxRefreshKind> {
    return {
      app,
      // The exact sheets Control linked while tmux was its active section (`tmuxIsActive ? uri(...)`,
      // after the three shell-wide ones), minus `vscode-theme.css`, which Control links for every section
      // and this surface never used a rule from. `inspector.css` styles no page frame, mints no `--ds-*`
      // and gives `#root` no height, so this app `conform`s and links no `page-frame.css`: the inspector
      // is a page-scrolling document like the task detail, not a full-bleed board.
      styleFiles: ["codicon.css", "design-system.css", "quick-picker.css", "inspector.css"],
      title: () => vscode.l10n.t("tmux"),
      refreshKindFor: tmuxRefreshKind,
      bind: (session) => {
        const send = async (): Promise<void> => {
          let model: InspectorModel;
          try {
            const [snap, server] = await Promise.all([this.deps.snapshot(), this.deps.serverHealth()]);
            model = buildInspectorModel(snap, this.deps.folderByHash(), this.deps.cpuBusy(snap), server);
          } catch {
            // A socket that cannot be read is an EMPTY server, not an error screen — carried over from
            // Control verbatim, because "no sessions" is what a stopped tmux server honestly looks like.
            model = { groups: [], totalSessions: 0, liveSessions: 0, deadSessions: 0, orphanSessions: 0, busySessions: 0 };
          }
          // The strings ride with every model rather than once at handshake: the model push IS the
          // catch-up path (`replay`), so a panel revived after a reload — which never sends a second
          // `ready` the host could answer with init — would otherwise paint with no strings at all.
          // t-6b5dea — the window scope rides the same way, and gains the property for free: every door
          // that repaints this screen (open, reveal, revive, reap, the client's own refresh) reads the
          // scope as it is AT THAT MOMENT, so no separate subscription has to keep it fresh and this app
          // still opens no fan-out door of its own.
          session.post(initMessage(inspectorStrings(), this.currentScope()));
          session.post(modelMessage(model));
        };
        return {
          // A tmux model is a full read of one socket, so a delta could carry nothing a rebuild does not.
          // What the gate's distinction still decides is how MANY of these run after a burst — one,
          // either way — not what they do. (Same shape as the Board's, and for the same reason.)
          replay: () => { void send(); },
          resync: () => { void send(); },
          onMessage: (raw) => { void this.handleAction(session, raw as Partial<InspectorAction>, send); },
        };
      },
    };
  }

  /**
   * The window's selected project, named — or nothing, when no project is selected (a window with no
   * folder attached, or a build with no scope wired).
   *
   * The LABEL is resolved host-side because the client cannot: the hash may belong to a project that owns
   * no session on this socket, and the client only ever learns folder names from the groups the model
   * carries. Falling back to the hash keeps the option nameable rather than blank in the case where the
   * scope points at a folder the snapshot does not mention.
   */
  private currentScope(): InspectorScope | undefined {
    const hash = this.scope?.current;
    if (!hash) return undefined;
    let label = hash;
    try {
      label = this.deps.folderByHash().get(hash) ?? hash;
    } catch {
      /* a folder map that cannot be read still leaves the hash, which is a real handle */
    }
    return { hash, label };
  }

  /**
   * The inspector's five human actions. `ready` and `refresh` never arrive here — `tmuxRefreshKind` claims
   * them for the gate — so everything below is an action on a panel someone is looking at.
   *
   * Ported from `Cockpit.ts`'s `handleInspectorAction` unchanged, including the two behaviours worth
   * naming because a cutover is exactly where they get quietly dropped: `kill` asks for a MODAL confirm
   * before it kills, and a failed capture posts an EMPTY capture rather than nothing, so the client's open
   * capture pane says "(no output)" instead of hanging on its previous text.
   */
  private async handleAction(
    session: SectionPanelSession<TmuxRefreshKind>,
    m: Partial<InspectorAction>,
    send: () => Promise<void>,
  ): Promise<void> {
    if (!m?.type) return;
    switch (m.type) {
      case "open":
        if (m.session) this.deps.open(m.session);
        return;
      case "reapDead":
        await this.deps.reapDead();
        await send();
        return;
      case "reapOrphans":
        await this.deps.reapOrphans();
        await send();
        return;
      case "capture": {
        if (!m.session) return;
        let text = "";
        try {
          text = await this.deps.capture(m.session);
        } catch {
          text = "";
        }
        session.post(captureMessage(m.session, text));
        return;
      }
      case "kill": {
        if (!m.session) return;
        const ok = await showNotification(
          vscode.l10n.t("Kill session {0}? This stops the process and removes the pane.", m.session),
          "warn",
          [vscode.l10n.t("Kill")],
          { modal: true },
        );
        if (!ok) return;
        try {
          await this.deps.kill(m.session);
        } catch {
          /* gone */
        }
        await send();
        return;
      }
      default:
        return;
    }
  }
}

/**
 * The ONE place that decides whether an inbound message is the client asking for work: the shell's SHARED
 * `ready` handshake and the inspector's own `refresh` (its auto-refresh timer and its Refresh button). A
 * string compare the HOST does — never a promise the client keeps — which is what makes the gate hold
 * whatever timer a client version happens to run. Exported so the rule is testable without a panel.
 */
export function tmuxRefreshKind(message: unknown): TmuxRefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === READY || type === "refresh" ? "tmux" : undefined;
}

/**
 * The l10n strings the host posts with every model. Moved here verbatim from `Cockpit.ts` — the extension
 * host owns the locale, so the strings are built extension-side and pushed, exactly as they were while
 * tmux was a Control section.
 */
export function inspectorStrings(): InspectorStrings {
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
    kindLogin: t("Runtime logins"),
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
    // t-6b5dea — "{1} hidden" is the number that keeps the scope default honest, and "Show every session"
    // is deliberately not the name of the Workspace filter's "All": this screen's universe is wider than
    // the attached projects, and the way out has to promise the wider set.
    scopeNote: t("Showing {0}, the project selected in the sidebar — {1} session(s) in other workspaces are hidden.", "{0}", "{1}"),
    scopeShowAll: t("Show every session"),
  };
}

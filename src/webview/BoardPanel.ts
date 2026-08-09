import * as vscode from "vscode";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelSession, type SectionPanelState, type SectionPanelTarget } from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { buildBoardVm, BoardAgentLists } from "../cockpit/boardVm.js";
import { READY, snapshotMessage, taskErrorMessage, type BoardAction } from "./board/messages.js";
import type { WorkspaceBoardTarget } from "../shell/BoardTarget.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";

export const BOARD_VIEW_TYPE = "tachyonBoard";

/** the one invalidation kind this app knows: "the board snapshot you are showing is stale". */
type BoardRefreshKind = "board";

/**
 * SDD 485 C5 — the Board as a standalone DASHBOARD app: one panel per project, revealed rather than
 * duplicated, opening as its own editor tab so it can sit BESIDE an agent terminal. That is the maintainer's
 * motivating case #1, and it is a capability ceiling of the single Control panel rather than a rough edge —
 * one panel shows exactly one screen (`spec.md`, Intent).
 *
 * Everything structural belongs to `SectionPanelManager` and is deliberately NOT restated here: the key
 * (`viewId | project`, because the manifest row says `cardinality: "dashboard"`), reveal-on-reopen, the shared
 * shell, the persisted state a reload revives from, and the `PanelWorkGate` that makes a hidden panel do no
 * work and a revealed one never stale. What is left for this file is the domain: which workspace a panel is
 * scoped to, how to build its snapshot, and what its six actions mean.
 *
 * **Why the workspace lookup is STRICT.** Control resolved "which workspace is the board about?" through a
 * fallback chain (preferred → the shell's global scope → the first attached root), because one panel had to
 * answer for whatever scope the human last chose. A dashboard panel is opened AGAINST a project and that
 * project IS half its key: resolving it loosely would let two panels land on the same workspace under
 * different keys, or let a panel silently retarget when the selector moves — which is the rule `spec.md`
 * states for documents and is no more acceptable for a dashboard. A project that is no longer attached says
 * so; it never borrows another project's tasks.
 *
 * **Hidden work.** Three doors reach this app and all three are gated by construction: `refresh()` (the
 * `views-changed` fan-out via `onTasksChanged`), the client's own 3s poll (claimed by `boardRefreshKind`,
 * which is the host-side form of Phase B's loudest fix), and every `session.post`. The bounded
 * agent-liveness pass's trailing retry is the one host-initiated re-push, and it re-enters through
 * `session.run` for exactly that reason — an ungated one would be the fifth door 0.56.159 was about.
 */
export interface BoardPanelDeps {
  getWorkspaces: () => WorkspaceBoardTarget[];
  /**
   * Open a task's own detail surface. Injected rather than performed here because the Board must not know
   * WHERE a task detail lives: today it is a Control subroute, and SDD 485 C4 makes it a `document` app.
   * This is the one wire that moves when that lands.
   */
  openTask: (ws: WorkspaceBoardTarget, taskId: string) => void;
  /** Open Task Studio for a new (`id` omitted) or existing task — still a Control studio route. */
  openTaskStudio: (ws: WorkspaceBoardTarget, id?: string) => void;
  /** the ONE fan-out every task mutation takes, whatever its source (see extension.ts's `onTasksChanged`). */
  onTasksChanged: () => void;
}

export class BoardPanelManager {
  private readonly manager: SectionPanelManager<BoardRefreshKind>;
  /**
   * The bounded/coalesced agent-liveness pass, moved no further than it had to be. It landed in
   * `src/cockpit/boardVm.ts` when SDD 410 retired the old standalone panel, and it is a pure function of a
   * workspace target with no Control anywhere in it — so it comes back to a standalone host by IMPORT rather
   * than by being moved a second time. One instance per manager: it coalesces per wsHash, so it is the two
   * project panels that would otherwise duplicate a request which share one.
   */
  private readonly agentLists = new BoardAgentLists();

  constructor(
    extensionUri: vscode.Uri,
    private readonly deps: BoardPanelDeps,
    app: WebviewAppEntry = webviewApp("board"),
    workspaceScope?: ControlWorkspaceScope,
  ) {
    this.manager = new SectionPanelManager<BoardRefreshKind>(extensionUri, this.configFor(app), workspaceScope);
  }

  /** Open the Board for one project, or REVEAL the panel already open for it. */
  open(project: string): void {
    this.manager.open({ project });
  }

  openInCurrentScope(): boolean {
    return this.manager.openInCurrentScope();
  }

  /** The fan-out door. Returns how many panels actually did work — visible ones only. */
  refresh(): number {
    return this.manager.refresh("board");
  }

  /** The upstream cursor expired: every hidden panel rebuilds on reveal instead of replaying. */
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

  private workspaceFor(target: SectionPanelTarget): WorkspaceBoardTarget | undefined {
    return this.deps.getWorkspaces().find((w) => w.wsHash === target.project);
  }

  private configFor(app: WebviewAppEntry): SectionAppConfig<BoardRefreshKind> {
    return {
      app,
      // The same sheets, in the same order, Control linked while the board was its active section
      // (Cockpit.ts's `missionIsActive ? …` pair, after the three shell-wide ones). The board's own
      // stylesheet neither styles the page frame nor mints `--ds-*` values, which is why this surface
      // `conform`s instead of declaring an extension point — checked by `webviewConvention.test.ts`
      // rather than asserted here.
      //
      // t-32c872 — `page-frame.css` is the sheet that list was MISSING, and its absence is the whole bug:
      // the board's per-column scrolling is a height chain rooted at `body`, and inside Control that root
      // came from cockpit.css. Standalone, the Board must link the shared frame itself. It is a shared
      // sheet, so this is conformance, not page chrome of its own — and the contract now checks the
      // CONSUMPTION, not just the declaration.
      styleFiles: ["codicon.css", "design-system.css", "page-frame.css", "vscode-theme.css", "board.tailwind.css", "board.css"],
      title: () => "Board",
      refreshKindFor: boardRefreshKind,
      bind: (session) => {
        const send = async (): Promise<void> => {
          const ws = this.workspaceFor(session.target);
          if (!ws) {
            session.post(taskErrorMessage(`No Tachyon workspace attached for this Board (${session.target.project}).`));
            return;
          }
          try {
            // The trailing retry re-enters through the GATE rather than calling `send` directly: a liveness
            // list that settles after its 250ms fallback already rendered must re-post real liveness, and a
            // panel hidden in the meantime must journal that instead of doing the work for nobody.
            const vm = await buildBoardVm(ws, this.agentLists, () => { session.run("board", () => { void send(); }); });
            session.post(snapshotMessage(vm));
          } catch (err) {
            session.post(taskErrorMessage(err instanceof Error ? err.message : String(err)));
          }
        };
        return {
          // `replay` and `resync` do the same work here, and that is a property of the surface rather than an
          // oversight: a board snapshot is a full read of one workspace, so there is nothing a delta could
          // carry that a rebuild does not. What the gate's distinction still decides is how MANY of these run
          // after a burst — one, either way — not what they do.
          replay: () => { void send(); },
          resync: () => { void send(); },
          onMessage: (raw) => { void this.handleAction(session, raw as Partial<BoardAction>); },
        };
      },
    };
  }

  /**
   * The board's six actions. `requestSnapshot` and `ready` never arrive here — `boardRefreshKind` claims them
   * for the gate — so everything below is a human action on a panel someone is looking at.
   */
  private async handleAction(session: SectionPanelSession<BoardRefreshKind>, m: Partial<BoardAction>): Promise<void> {
    if (!m?.type) return;
    // Copying an id touches no workspace, so it must not be refused when one is missing.
    if (m.type === "copyTaskId" && typeof m.id === "string") {
      await vscode.env.clipboard.writeText(m.id);
      return;
    }
    const ws = this.workspaceFor(session.target);
    if (!ws) {
      session.post(taskErrorMessage(`No Tachyon workspace attached for this Board (${session.target.project}).`));
      return;
    }
    const taskId = "id" in m && typeof m.id === "string" ? m.id : undefined;
    try {
      if (m.type === "updateTask" && typeof m.id === "string" && m.patch) {
        await ws.updateTask(m.id, m.patch);
        this.deps.onTasksChanged();
      } else if (m.type === "reorderLane" && typeof m.status === "string" && Array.isArray(m.orderedIds) && m.expect) {
        await ws.reorderLane(m.status, m.priority, { orderedIds: m.orderedIds, expect: m.expect });
        this.deps.onTasksChanged();
      } else if (m.type === "closeValidation" && typeof m.id === "string" && typeof m.result_note === "string" && m.outcome) {
        await ws.closeValidation(m.id, { outcome: m.outcome, result_note: m.result_note });
        this.deps.onTasksChanged();
      } else if (m.type === "openTask" && typeof m.id === "string") {
        this.deps.openTask(ws, m.id);
      } else if (m.type === "openTaskStudio") {
        this.deps.openTaskStudio(ws, typeof m.id === "string" ? m.id : undefined);
      }
    } catch (err) {
      // The board never moves a card optimistically, so a rejection needs no rollback — only a message the
      // human can read, carrying the task id when the failure belongs to one (spec 335's "no optimistic
      // divergence": a fresh snapshot is the only thing that ever moves a card). No re-post on failure — the
      // success path's fan-out is what re-posts, and an identical snapshot here would hide the error.
      session.post(taskErrorMessage(err instanceof Error ? err.message : String(err), taskId));
    }
  }
}

/**
 * The ONE place that decides whether an inbound message is the client asking for work: the shell's SHARED
 * `ready` handshake and the board's own `requestSnapshot` (its 3s poll and its explicit refreshes). A string
 * compare the HOST does — never a promise the client keeps — which is what makes the gate hold whatever timer
 * a client version happens to run. Exported so the rule is testable without a panel.
 */
export function boardRefreshKind(message: unknown): BoardRefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === READY || type === "requestSnapshot" ? "board" : undefined;
}

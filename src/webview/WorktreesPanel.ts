import * as vscode from "vscode";
import { buildCockpitModel, collectNeedsFor, type CockpitWorkspaceBundle } from "../cockpit/model.js";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelSession, type SectionPanelState } from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { POLL, READY, worktreesErrorMessage, worktreesModelMessage } from "./worktrees/messages.js";

export const WORKTREES_VIEW_TYPE = "tachyonWorktrees";
type WorktreesRefreshKind = "worktrees";

export interface WorktreesDeps {
  collect: (needs?: ReturnType<typeof collectNeedsFor>) => Promise<CockpitWorkspaceBundle[]>;
  revealPath(path: string): void;
  remove(id: string, deleteBranch: boolean, wsHash: string): Promise<string | undefined>;
  forget(id: string, wsHash: string): Promise<string | undefined>;
}

/**
 * SDD 485 D6 — Worktrees is a dashboard because its source is project-filtered by
 * `buildCockpitModel(..., { wsHash })`. Actions use the panel's immutable project, never a row-supplied
 * fallback, so project A cannot remove a worktree belonging to project B.
 *
 * No legacy standalone id exists: Worktrees was born inside Control, so a new viewType is the honest
 * persisted contract. The ck-wt-* leaf moved with its sole consumer; ck-card-list remains in the linked
 * engine-workspace sheet, while ck-mono has its own shared typography sheet for Control + Worktrees.
 */
export class WorktreesPanelManager {
  private readonly manager: SectionPanelManager<WorktreesRefreshKind>;

  constructor(
    extensionUri: vscode.Uri,
    private readonly deps: WorktreesDeps,
    app: WebviewAppEntry = webviewApp("worktrees"),
    scope?: ControlWorkspaceScope,
  ) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app), scope);
  }

  open(project: string): void { this.manager.open({ project }); }
  get openKeys(): string[] { return this.manager.openKeys; }
  openInCurrentScope(): boolean { return this.manager.openInCurrentScope(); }
  refresh(): void { this.manager.refresh("worktrees"); }
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void { this.manager.deserialize(panel, state); }
  dispose(): void { this.manager.dispose(); }

  private configFor(app: WebviewAppEntry): SectionAppConfig<WorktreesRefreshKind> {
    return {
      app,
      styleFiles: [
        "codicon.css",
        "design-system.css",
        "control-typography.css",
        "engine-workspace.css",
        "worktrees.css",
      ],
      title: () => vscode.l10n.t("Worktrees"),
      bootstrapGlobals: () => ({ __TACHYON_STRINGS__: worktreesStrings() }),
      refreshKindFor: worktreesRefreshKind,
      bind: (session) => {
        const send = () => void this.send(session);
        return { replay: send, resync: send, onMessage: (raw) => void this.action(session, raw) };
      },
    };
  }

  private async send(session: SectionPanelSession<WorktreesRefreshKind>): Promise<void> {
    try {
      const bundles = await this.deps.collect(collectNeedsFor("worktrees"));
      session.post(worktreesModelMessage(buildCockpitModel(bundles, {
        section: "worktrees",
        wsHash: session.target.project,
      })));
    } catch (error) {
      session.post(worktreesErrorMessage(error instanceof Error ? error.message : String(error)));
    }
  }

  private async action(session: SectionPanelSession<WorktreesRefreshKind>, raw: unknown): Promise<void> {
    const message = raw as Record<string, unknown>;
    if (message.type === "revealPath" && typeof message.path === "string") this.deps.revealPath(message.path);
    else if (message.type === "copyText" && typeof message.text === "string") await vscode.env.clipboard.writeText(message.text);
    else if (message.type === "worktreeRemove" && typeof message.id === "string") {
      await this.runOne(session, "remove", message.id, message.deleteBranch === true);
    } else if (message.type === "worktreeForgetRecord" && typeof message.id === "string") {
      await this.runOne(session, "forget", message.id, false);
    } else if (message.type === "worktreeBatchCleanup" && Array.isArray(message.items)) {
      for (const item of message.items) {
        const row = item as { id?: unknown; op?: unknown };
        if (typeof row.id === "string" && (row.op === "remove" || row.op === "forget")) {
          await this.runOne(session, row.op, row.id, false);
        }
      }
    }
  }

  private async runOne(session: SectionPanelSession<WorktreesRefreshKind>, op: "remove" | "forget", id: string, deleteBranch: boolean): Promise<void> {
    const project = session.target.project;
    if (!project) throw new Error("Worktrees dashboard has no project");
    const refusal = op === "remove" ? await this.deps.remove(id, deleteBranch, project) : await this.deps.forget(id, project);
    if (refusal) void vscode.window.showWarningMessage(refusal);
    await this.send(session);
  }
}

export function worktreesRefreshKind(message: unknown): WorktreesRefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === READY || type === POLL ? "worktrees" : undefined;
}

function worktreesStrings(): Record<string, string> {
  const t = vscode.l10n.t;
  return {
    worktreesTitle: t("Managed worktrees"),
    worktreesHint: t("Tachyon-managed checkouts — reveal and copy paths."),
    agent: t("agent"),
    change: t("change"),
    branch: t("Branch"),
    reveal: t("Reveal"),
    copyPath: t("Copy path"),
    noneListed: t("Nothing listed for this workspace yet."),
    landTitle: t("Land this delivery"),
    landIntro: t("Tachyon never moves the trunk. When every precondition below is proved, this is the exact command — you run it."),
    landCommandLabel: t("Land command"),
    landCopyCommand: t("Copy command"),
    landBlocked: t("Not ready to land — {0} precondition(s) not proved. No command is offered: one that would fail wastes your time, and one that would succeed here would land something nobody verified."),
    landCheckWorktreeClean: t("Worktree clean"),
    landCheckVerifiedTree: t("Verified tree"),
    landCheckFastForward: t("Fast-forward"),
    landCheckPrimaryOnTrunk: t("Primary checkout on the trunk"),
    landCheckPrimaryClean: t("Primary checkout clean"),
    landFixLabel: t("Fix"),
    landCommits: t("commit(s)"),
    wtAgentGone: t("Agent no longer exists — leftover checkout"),
    wtAgentOwned: t("Managed by Agent Studio → Forget"),
    wtAlsoDeleteBranch: t("Also delete local branch"),
    wtBlocked: t("Blocked"),
    wtCancel: t("Cancel"),
    wtClearSelection: t("Clear"),
    wtConfirmBody: t("Each entry is re-checked at execution — one whose state changed is skipped with a reason, the rest proceed."),
    wtConfirmRun: t("Run cleanup"),
    wtConfirmTitle: t("Confirm cleanup"),
    wtEngineUnavailable: t("Engine unavailable — registry not shown (unverified data is never displayed)."),
    wtForgetRecord: t("Forget record"),
    wtOccupiedBy: t("occupied by"),
    wtOccupiedDesc: t("A live agent holds this checkout right now."),
    wtOccupiedTitle: t("Occupied"),
    wtReadyDesc: t("Clean, unoccupied, and every commit is already in its base branch. Safe to delete."),
    wtReadyTitle: t("Ready to remove"),
    wtRecordDesc: t("The registry row survives, but the checkout's directory is gone. Nothing to reveal — just forget the row."),
    wtRecordTitle: t("Record-only"),
    wtRemoveCheckout: t("Remove checkout"),
    wtReviewConfirm: t("Review & confirm…"),
    wtReviewDesc: t("Blocked from cleanup — read the reason before touching these by hand."),
    wtReviewTitle: t("Needs review"),
    wtSelectAll: t("Select all"),
    wtSelected: t("selected"),
    wtShowAll: t("Show all"),
  };
}

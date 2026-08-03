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
 * persisted contract. The ck-wt-* leaf moved with its sole consumer; engine-workspace.css remains linked
 * because ck-card-list/ck-mono still have multiple consumers.
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
  openInCurrentScope(): boolean { return this.manager.openInCurrentScope(); }
  refresh(): void { this.manager.refresh("worktrees"); }
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void { this.manager.deserialize(panel, state); }
  dispose(): void { this.manager.dispose(); }

  private configFor(app: WebviewAppEntry): SectionAppConfig<WorktreesRefreshKind> {
    return {
      app,
      styleFiles: ["codicon.css", "design-system.css", "engine-workspace.css", "worktrees.css"],
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
    worktreesTitle: t("Managed worktrees"), worktreesHint: t("Tachyon-managed checkouts — reveal and copy paths."),
    agent: t("Agent"), change: t("Change"), branch: t("Branch"), reveal: t("Reveal"), copyPath: t("Copy path"), noneListed: t("Nothing to show."),
    wtAgentGone: t("Agent no longer exists"), wtAgentOwned: t("Managed by Agent Studio"), wtAlsoDeleteBranch: t("Also delete branch"), wtBlocked: t("Blocked"),
    wtCancel: t("Cancel"), wtClearSelection: t("Clear"), wtConfirmBody: t("The engine re-validates every item before changing it."), wtConfirmRun: t("Run cleanup"), wtConfirmTitle: t("Confirm cleanup"),
    wtEngineUnavailable: t("Worktree data is unavailable."), wtForgetRecord: t("Forget record"), wtOccupiedBy: t("Occupied by"), wtOccupiedDesc: t("Currently used by an agent."), wtOccupiedTitle: t("Occupied"),
    wtReadyDesc: t("Safe to remove."), wtReadyTitle: t("Ready to remove"), wtRecordDesc: t("Registry entries without a checkout."), wtRecordTitle: t("Record only"), wtRemoveCheckout: t("Remove checkout"),
    wtReviewConfirm: t("Review"), wtReviewDesc: t("Needs human review."), wtReviewTitle: t("Needs review"), wtSelectAll: t("Select all"), wtSelected: t("selected"), wtShowAll: t("Show all"),
  };
}

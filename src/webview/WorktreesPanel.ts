import * as vscode from "vscode";
import { buildSectionsModel, collectNeedsFor, type WorkspaceBundle } from "../sections/model.js";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelSession, type SectionPanelState } from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import {
  POLL,
  READY,
  worktreesErrorMessage,
  worktreesModelMessage,
  worktreeLandResultMessage,
  worktreePrDraftMessage,
  worktreeReviewFilesMessage,
  type WorktreeLandResult,
  type WorktreePrDraftView,
  type WorktreeReviewFile,
} from "./worktrees/messages.js";
import type { WorktreePrDraft, WorktreePrSelection, WorktreeReviewSelection } from "../presentation/items.js";

export const WORKTREES_VIEW_TYPE = "tachyonWorktrees";
type WorktreesRefreshKind = "worktrees";

export interface WorktreesDeps {
  collect: (needs?: ReturnType<typeof collectNeedsFor>) => Promise<WorkspaceBundle[]>;
  revealPath(path: string): void;
  remove(id: string, deleteBranch: boolean, wsHash: string): Promise<string | undefined>;
  forget(id: string, wsHash: string): Promise<string | undefined>;
  /** t-d29398 — release a preserved checkout's Git quarantine (non-destructive; never removes). */
  releaseLock(id: string, wsHash: string): Promise<string | undefined>;
  /**
   * SDD 498 — fast-forward the trunk onto this delivery, in the primary checkout.
   *
   * Unlike its neighbours this does NOT answer a refusal string for a toast: the outcome — success or
   * refusal — is rendered in the land block, where the exit it names has room to be read and stays put.
   */
  land(id: string, wsHash: string): Promise<WorktreeLandResult>;
}

/**
 * SDD 485 D6 — Worktrees is a dashboard because its source is project-filtered by
 * `buildSectionsModel(..., { wsHash })`. Actions use the panel's immutable project, never a row-supplied
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
        "tokens.css", "faces.css", "design-system.css", "quick-picker.css",
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
      session.post(worktreesModelMessage(buildSectionsModel(bundles, {
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
    } else if (message.type === "worktreeReleaseLock" && typeof message.id === "string") {
      await this.runOne(session, "releaseLock", message.id, false);
    } else if (message.type === "worktreeReviewDiff" && typeof message.id === "string") {
      // t-ea5425 — ask the review command for its candidates and hand them to the webview's own picker.
      // The command still refuses (and says so) for a row with no committed history or no changes; a
      // refusal answers `undefined`, and an undefined answer opens no picker rather than an empty one.
      const candidates = await this.dispatch(session, "tachyon.reviewWorktreeItem", message.id, "list");
      const review = reviewCandidatesOf(candidates);
      if (review) session.post(worktreeReviewFilesMessage({ id: message.id, ...review }));
    } else if (message.type === "worktreeOpenReviewFile" && typeof message.id === "string" && typeof message.path === "string") {
      // The choice goes back through the SAME command, which opens the one diff. The path is re-resolved
      // there against a fresh changed-file list, so a file that vanished since the picker was drawn is
      // named as gone instead of opening a diff of nothing.
      await this.dispatch(session, "tachyon.reviewWorktreeItem", message.id, { file: message.path });
    } else if (message.type === "worktreeCreatePr" && typeof message.id === "string") {
      // t-f3ded3 — ask the same command for a draft (probe at THIS click), then draw ConfirmForm.
      // Refusal answers undefined and opens no form; create still runs only on confirm.
      const draft = await this.dispatch(session, "tachyon.createWorktreePrItem", message.id, "draft");
      const view = prDraftOf(message.id, draft);
      if (view) session.post(worktreePrDraftMessage(view));
    } else if (message.type === "worktreeConfirmPr" && typeof message.id === "string" && typeof message.title === "string") {
      // Confirm carries the edited title only. The host re-resolves the row and creates; no second probe.
      await this.dispatch(session, "tachyon.createWorktreePrItem", message.id, { title: message.title });
    } else if (message.type === "worktreeLand" && typeof message.id === "string") {
      await this.land(session, message.id);
    } else if (message.type === "worktreeBatchCleanup" && Array.isArray(message.items)) {
      for (const item of message.items) {
        const row = item as { id?: unknown; op?: unknown };
        if (typeof row.id === "string" && (row.op === "remove" || row.op === "forget")) {
          await this.runOne(session, row.op, row.id, false);
        }
      }
    }
  }

  /**
   * SDD 501 — hand a land-block action to the command that already implements it.
   *
   * This is the sidebar's routing, not a new one: an action id is mapped to an EXISTING VS Code command
   * and called with a duck-typed item the handler reads its fields off (`SidebarPrototype.ts:72,530`).
   * Two things follow from being a dashboard rather than the sidebar. The project is the panel's own
   * immutable one, never the row's `wsHash` — the same rule every mutation here already obeys (SDD 485
   * D6), and it holds for a read too, because "review project B's checkout from project A's panel" is
   * the same crossing. And nothing is dispatched on a refresh: these two commands probe at click, which
   * is the property spec 223 bought and `prReadinessProbedAtClick.test.ts` keeps.
   *
   * There is deliberately no local review or PR implementation to fall back on. A refusal — no such
   * row, no committed history, no `gh` — is the command's to make and to name.
   */
  private async dispatch(
    session: SectionPanelSession<WorktreesRefreshKind>,
    command: "tachyon.reviewWorktreeItem" | "tachyon.createWorktreePrItem",
    worktreeId: string,
    select?: WorktreeReviewSelection | WorktreePrSelection,
  ): Promise<unknown> {
    const project = session.target.project;
    if (!project) throw new Error("Worktrees dashboard has no project");
    return await vscode.commands.executeCommand(command, { workspaceHash: project, worktreeId, ...(select ? { select } : {}) });
  }

  /**
   * SDD 498 — the one gesture that moves the trunk.
   *
   * The project is the panel's own immutable one, never the row's `wsHash` — the same rule every
   * mutation here already obeys (SDD 485 D6). The outcome is POSTED to the block and then the model is
   * re-sent: the post carries the words, the refresh carries the freshly measured preconditions, and a
   * successful land makes the row's work contained in the trunk so the block removes itself.
   */
  private async land(session: SectionPanelSession<WorktreesRefreshKind>, id: string): Promise<void> {
    const project = session.target.project;
    if (!project) throw new Error("Worktrees dashboard has no project");
    let result: WorktreeLandResult;
    try {
      result = await this.deps.land(id, project);
    } catch (error) {
      // An engine that cannot be reached is a refusal that must SAY so. There is deliberately no
      // extension-host fallback: a second implementation of the decision is the defect SDD 498 removes.
      result = {
        id,
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        fix: "the engine did not answer, so nothing was landed. Check that it is running and try again — nothing falls back to the extension host for this act",
      };
    }
    session.post(worktreeLandResultMessage(result));
    await this.send(session);
  }

  private async runOne(
    session: SectionPanelSession<WorktreesRefreshKind>,
    op: "remove" | "forget" | "releaseLock",
    id: string,
    deleteBranch: boolean,
  ): Promise<void> {
    const project = session.target.project;
    if (!project) throw new Error("Worktrees dashboard has no project");
    const refusal = op === "remove"
      ? await this.deps.remove(id, deleteBranch, project)
      : op === "releaseLock"
        ? await this.deps.releaseLock(id, project)
        : await this.deps.forget(id, project);
    if (refusal) void vscode.window.showWarningMessage(refusal);
    await this.send(session);
  }
}

/**
 * t-ea5425 — the command's answer, narrowed to what the picker shows.
 *
 * `executeCommand` is an untyped boundary, so the shape is CHECKED rather than asserted, and only the
 * three fields the list renders cross into the webview: a changed-file record carries more than a
 * picker needs, and what is not sent cannot be leaked by a future field. An answer that is not a
 * candidate set (the command refused and already said why) yields `undefined` — no picker at all.
 */
function reviewCandidatesOf(value: unknown): { label: string; base: string; current: string; files: WorktreeReviewFile[] } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const c = value as { label?: unknown; base?: unknown; current?: unknown; files?: unknown };
  if (typeof c.label !== "string" || typeof c.base !== "string" || typeof c.current !== "string") return undefined;
  if (!Array.isArray(c.files) || c.files.length === 0) return undefined;
  const files: WorktreeReviewFile[] = [];
  for (const raw of c.files) {
    const f = raw as { path?: unknown; status?: unknown; from?: unknown };
    if (typeof f.path !== "string" || typeof f.status !== "string") return undefined;
    files.push({ path: f.path, status: f.status, ...(typeof f.from === "string" ? { from: f.from } : {}) });
  }
  return { label: c.label, base: c.base, current: c.current, files };
}

/**
 * t-f3ded3 — the command's draft answer, narrowed to what ConfirmForm shows.
 *
 * Checked rather than asserted (same as review candidates): only the fields the form needs cross
 * into the webview. A refusal (no worktree, not ready) answers undefined — no form at all.
 */
function prDraftOf(id: string, value: unknown): WorktreePrDraftView | undefined {
  if (!value || typeof value !== "object") return undefined;
  const d = value as WorktreePrDraft;
  if (typeof d.subject !== "string" || typeof d.branch !== "string") return undefined;
  if (typeof d.title !== "string" || typeof d.body !== "string") return undefined;
  if (!(d.base === null || typeof d.base === "string") || typeof d.dirty !== "boolean") return undefined;
  return {
    id,
    subject: d.subject,
    branch: d.branch,
    title: d.title,
    body: d.body,
    base: d.base,
    dirty: d.dirty,
  };
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
    // SDD 498 — this sentence used to read "Tachyon never moves the trunk … you run it", and it is
    // false now: the product performs the fast-forward under a human's click. What has NOT changed is
    // the half that matters, so the new text says it explicitly — green is information, never
    // permission, and nothing lands on its own.
    landIntro: t("When every precondition below is proved, Tachyon fast-forwards the trunk onto this delivery, in the primary checkout, when you press Land. It never lands on its own."),
    landCommandLabel: t("Land command"),
    landCopyCommand: t("Copy command"),
    landBlocked: t(
      "Not ready to land — {0} precondition(s) not proved. No command is offered: one that would fail"
      + " wastes your time, and one that would succeed here would land something nobody verified.",
    ),
    landCheckWorktreeClean: t("Worktree clean"),
    landCheckVerifiedTree: t("Verified tree"),
    landCheckFastForward: t("Fast-forward"),
    landCheckPrimaryOnTrunk: t("Primary checkout on the trunk"),
    landCheckPrimaryClean: t("Primary checkout clean"),
    landFixLabel: t("Fix"),
    landCommits: t("commit(s)"),
    landAction: t("Land"),
    landActing: t("Landing…"),
    landOk: t("Landed — '{0}' moved {1} → {2}."),
    landRefused: t("Not landed."),
    landUndo: t("To undo, in the primary checkout:"),
    landReview: t("Review these changes"),
    landPropose: t("Open a pull request"),
    // t-ea5425 — the same two sentences the native quick pick showed, now on the product picker.
    landReviewPickTitle: t("Review '{0}' — {1} changed file(s)"),
    landReviewPickPlaceholder: t("Open a file's diff ({0} ↔ {1})"),
    landReviewPickEmpty: t("No changed file matches"),
    // t-f3ded3 — same sentences the native InputBox + modal used; the form is ours, the words stay.
    landPrFormTitle: t("Create PR for '{0}'"),
    landPrFormSubtitle: t("Open a GitHub PR for branch '{0}'?"),
    landPrTitleLabel: t("PR title"),
    landPrBodyLabel: t("Body"),
    landPrConfirm: t("Create PR"),
    landPrBase: t("Base branch: {0}"),
    landPrBaseDefault: t("Base: gh's default — confirm on the PR page"),
    landPrDirty: t("⚠ Uncommitted changes won't be in the PR — commit them first."),
    landCompare: t("Review shows {0}..{1} — the commits this command would land, not the working tree."),
    landCompareBlocked: t("Review opens a committed-history comparison, not the working tree."),
    landCompareNoTrunk: t("No local trunk to compare against — review shows this branch against the ref it was forked from."),
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
    wtLockedTitle: t("Preserved — quarantined"),
    wtLockedDesc: t(
      "A launch was interrupted and Git still holds this checkout. Nothing can reuse or remove it until"
      + " the lock is released — releasing it deletes nothing.",
    ),
    wtReleaseLock: t("Release lock"),
    wtInsideLabel: t("Inside"),
    wtInsideClean: t("no uncommitted changes"),
    wtInsideDirty: t("uncommitted changes"),
    wtInsideCommits: t("{0} commit(s) beyond its base"),
    wtInsideUnknown: t("contents could not be measured"),
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

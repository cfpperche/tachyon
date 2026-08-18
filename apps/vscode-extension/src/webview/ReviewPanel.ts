/**
 * SDD 513 fatia 3 / t-1a76c5 — the Tachyon review tab.
 *
 * Board / Activity / Plugins already open as editor tabs through SectionPanelManager.
 * This is the same mould: cardinality `document` so two worktrees sit side by side,
 * and the panel is only revealed when the human's review command asks for it.
 * Annotating, reconciling, or receiving a note must not open, reveal, or resize
 * anything — that is the defect the Comments panel had.
 */
import * as vscode from "vscode";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelSession,
  type SectionPanelState,
} from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import {
  READY,
  reviewErrorMessage,
  reviewMessage,
  type ReviewAction,
  type ReviewAgent,
  type ReviewVM,
} from "@tachyon/webview-ui/webview/review/messages";
import type { ChangedFile } from "@tachyon/engine/worktree/review.js";
import type { ReviewNote } from "@tachyon/engine/worktree/reviewNotes.js";
import type { ReviewDiffFileV1, ReviewDiffQueryInputV1 } from "@tachyon/engine/runtime-api/reviewProjection.js";
import type { ReviewMutationInputV1 } from "@tachyon/engine/runtime-api/reviewCommands.js";
import type { WorktreeEvidence } from "@tachyon/engine/worktree/evidence.js";
import {
  REVIEW_NOTE_CAPTURE_K,
  composeReviewNotesPrompt,
  mintCommentId,
  mintEvidenceId,
  promptNotesFromView,
  reviewNotesEvidenceRecord,
} from "../review/batch.js";

export const REVIEW_VIEW_TYPE = "tachyonReview";

type ReviewRefreshKind = "review";

export interface ReviewOpenArgs {
  workspaceHash: string;
  worktree: string;
  cwd: string;
  baseRef: string;
  currentLabel: string;
  files: ChangedFile[];
  selectedPath?: string;
  headRef?: string;
}

export interface ReviewPanelHost {
  loadSession(worktree: string, workspaceHash: string): Promise<Omit<ReviewOpenArgs, "selectedPath"> | undefined>;
  viewNotes(worktree: string, k: number, workspaceHash: string): Promise<ReviewNote[]>;
  viewDiff(input: ReviewDiffQueryInputV1, workspaceHash: string): Promise<ReviewDiffFileV1>;
  upsert(input: Extract<ReviewMutationInputV1, { action: "note.upsert" }>, workspaceHash: string): Promise<void>;
  listAgents(cwd: string, workspaceHash: string): Promise<ReviewAgent[]>;
  sendPrompt(agent: string, text: string, workspaceHash: string): Promise<void>;
  attachEvidence(workspaceHash: string, record: WorktreeEvidence): Promise<void>;
  resolveHead(cwd: string): Promise<string | undefined>;
  notify(message: string, kind: "info" | "warn" | "error"): void;
}

interface LiveReview {
  args: ReviewOpenArgs;
  notes: ReviewNote[];
  agents: ReviewAgent[];
  diff: ReviewDiffFileV1 | null;
  diffLoading: boolean;
  selectedPath: string | null;
}

export class ReviewPanelManager {
  private readonly manager: SectionPanelManager<ReviewRefreshKind>;
  private readonly pending = new Map<string, ReviewOpenArgs>();
  private readonly live = new Map<string, { session: SectionPanelSession<ReviewRefreshKind>; state: LiveReview }>();

  constructor(
    extensionUri: vscode.Uri,
    private readonly host: ReviewPanelHost,
    app: WebviewAppEntry = webviewApp("review"),
  ) {
    this.manager = new SectionPanelManager<ReviewRefreshKind>(extensionUri, this.configFor(app));
  }

  /** The command door. Never called from a note write, a reconcile, or an inbound event. */
  open(args: ReviewOpenArgs): void {
    const target = { project: args.workspaceHash, identity: args.worktree };
    const key = this.manager.keyFor(target);
    this.pending.set(key, args);
    const already = this.live.has(key);
    this.manager.open(target);
    if (already) {
      const live = this.live.get(key);
      if (live && args.selectedPath) void this.selectFile(live, args.selectedPath);
    }
  }

  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void {
    this.manager.deserialize(panel, state);
  }

  get openKeys(): string[] {
    return this.manager.openKeys;
  }

  dispose(): void {
    this.manager.dispose();
    this.pending.clear();
    this.live.clear();
  }

  private configFor(app: WebviewAppEntry): SectionAppConfig<ReviewRefreshKind> {
    return {
      app,
      styleFiles: [
        "codicon.css",
        "tokens.css",
        "faces.css",
        "design-system.css",
        "quick-picker.css",
        "page-frame.css",
        "review.css",
      ],
      title: (target) => vscode.l10n.t("Review — {0}", target.identity ?? ""),
      iconName: "note",
      refreshKindFor: reviewRefreshKind,
      bind: (session) => this.bind(session),
    };
  }

  private bind(session: SectionPanelSession<ReviewRefreshKind>) {
    const key = session.key;
    const seed = this.pending.get(key);
    const state: LiveReview = {
      args: seed ?? {
        workspaceHash: session.target.project ?? "",
        worktree: session.target.identity ?? "",
        cwd: "",
        baseRef: "",
        currentLabel: "worktree",
        files: [],
      },
      notes: [],
      agents: [],
      diff: null,
      diffLoading: false,
      selectedPath: seed?.selectedPath ?? seed?.files[0]?.path ?? null,
    };
    this.live.set(key, { session, state });
    const send = (): void => { void this.resync(session, state); };
    return {
      replay: send,
      resync: send,
      onMessage: (raw: unknown) => { void this.handleAction(session, state, raw as Partial<ReviewAction>); },
      dispose: () => {
        if (this.live.get(key)?.session === session) this.live.delete(key);
        this.pending.delete(key);
      },
    };
  }

  private async resync(session: SectionPanelSession<ReviewRefreshKind>, state: LiveReview): Promise<void> {
    if (!state.args.cwd || state.args.files.length === 0) {
      const loaded = await this.host.loadSession(state.args.worktree, state.args.workspaceHash);
      if (!loaded) {
        session.post(reviewErrorMessage(`No Tachyon worktree is available to review (${state.args.worktree}).`));
        return;
      }
      state.args = { ...loaded, selectedPath: state.selectedPath ?? loaded.files[0]?.path };
      state.selectedPath = state.args.selectedPath ?? loaded.files[0]?.path ?? null;
    }
    await this.refreshNotesAndAgents(state);
    if (state.selectedPath) await this.loadDiff(state, state.selectedPath);
    this.post(session, state);
  }

  private async handleAction(
    session: SectionPanelSession<ReviewRefreshKind>,
    state: LiveReview,
    message: Partial<ReviewAction>,
  ): Promise<void> {
    if (!message?.type || message.type === READY) return;
    if (message.type === "review.diff" && typeof message.path === "string") {
      await this.selectFile({ session, state }, message.path);
      return;
    }
    if (message.type === "review.upsertNote"
      && typeof message.path === "string"
      && typeof message.line === "number"
      && typeof message.body === "string") {
      await this.upsertNote(session, state, message.path, message.line, message.body);
      return;
    }
    if (message.type === "review.sendBatch" && typeof message.agent === "string") {
      await this.sendBatch(session, state, message.agent);
    }
  }

  private async selectFile(
    live: { session: SectionPanelSession<ReviewRefreshKind>; state: LiveReview },
    path: string,
  ): Promise<void> {
    live.state.selectedPath = path;
    live.state.diffLoading = true;
    this.post(live.session, live.state);
    await this.loadDiff(live.state, path);
    live.state.diffLoading = false;
    this.post(live.session, live.state);
  }

  private async loadDiff(state: LiveReview, filePath: string): Promise<void> {
    try {
      state.diff = await this.host.viewDiff({
        worktree: state.args.worktree,
        path: filePath,
        baseRef: state.args.baseRef,
        ...(state.args.headRef !== undefined ? { headRef: state.args.headRef } : {}),
      }, state.args.workspaceHash);
    } catch (error) {
      state.diff = null;
      state.args = { ...state.args };
      this.host.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  }

  private async refreshNotesAndAgents(state: LiveReview): Promise<void> {
    try {
      state.notes = await this.host.viewNotes(state.args.worktree, REVIEW_NOTE_CAPTURE_K, state.args.workspaceHash);
    } catch {
      state.notes = [];
    }
    try {
      state.agents = await this.host.listAgents(state.args.cwd, state.args.workspaceHash);
    } catch {
      state.agents = [];
    }
  }

  private async upsertNote(
    session: SectionPanelSession<ReviewRefreshKind>,
    state: LiveReview,
    filePath: string,
    line: number,
    body: string,
  ): Promise<void> {
    try {
      await this.host.upsert({
        action: "note.upsert",
        id: mintCommentId(),
        worktree: state.args.worktree,
        baseRef: state.args.baseRef,
        path: filePath,
        body,
        line,
        k: REVIEW_NOTE_CAPTURE_K,
        ...(state.args.headRef !== undefined ? { headRef: state.args.headRef } : {}),
        hintRange: { startLine: line, endLine: line },
        endLine: line,
      }, state.args.workspaceHash);
      await this.refreshNotesAndAgents(state);
      this.post(session, state);
    } catch (error) {
      session.post(reviewErrorMessage(error instanceof Error ? error.message : String(error)));
    }
  }

  private async sendBatch(
    session: SectionPanelSession<ReviewRefreshKind>,
    state: LiveReview,
    agent: string,
  ): Promise<void> {
    if (state.notes.length === 0) {
      this.host.notify(vscode.l10n.t("Nothing to send — there are no review notes yet."), "warn");
      return;
    }
    const promptNotes = promptNotesFromView(state.notes);
    const prompt = composeReviewNotesPrompt({ baseRef: state.args.baseRef, notes: promptNotes });
    const producedAt = new Date().toISOString();
    const atCommit = await this.host.resolveHead(state.args.cwd);
    if (atCommit) {
      try {
        await this.host.attachEvidence(state.args.workspaceHash, reviewNotesEvidenceRecord({
          targetAgent: agent,
          atCommit,
          producedAt,
          id: mintEvidenceId(producedAt),
          baseRef: state.args.baseRef,
          worktree: state.args.worktree,
          prompt,
          notes: promptNotes,
        }));
      } catch {
        /* evidence is best-effort; the prompt still goes */
      }
    }
    await this.host.sendPrompt(agent, prompt, state.args.workspaceHash);
    this.host.notify(vscode.l10n.t("Review notes sent to '{0}'.", agent), "info");
    this.post(session, state);
  }

  private post(session: SectionPanelSession<ReviewRefreshKind>, state: LiveReview): void {
    session.post(reviewMessage(vmFrom(state)));
  }
}

export function reviewRefreshKind(message: unknown): ReviewRefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  return (message as { type?: unknown }).type === READY ? "review" : undefined;
}

function vmFrom(state: LiveReview): ReviewVM {
  return {
    worktree: state.args.worktree,
    baseRef: state.args.baseRef,
    currentLabel: state.args.currentLabel,
    ...(state.args.headRef !== undefined ? { headRef: state.args.headRef } : {}),
    k: REVIEW_NOTE_CAPTURE_K,
    files: state.args.files,
    selectedPath: state.selectedPath,
    diff: state.diff,
    diffLoading: state.diffLoading,
    notes: state.notes,
    agents: state.agents,
  };
}

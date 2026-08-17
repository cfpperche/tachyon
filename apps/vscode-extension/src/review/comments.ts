/**
 * SDD 511 fatia 3 / t-a0d820 — CommentController + send-batch, the VS Code half.
 *
 * Snapshot is truth (engine). A platform range is a hint. Note identity never
 * mentions a URI — live threads are keyed by commentId. The modified side has
 * two URI forms (file: when there is no headRef, tachyon-worktree: when there
 * is); one locator serves both. Restore from review.view before creating a
 * thread. A failed hint push is not a failure: the next read re-derives.
 *
 * k is the measured capture from t-232111, not a uniqueness claim.
 */
import type * as vscode from "vscode";
import type { ReviewNote } from "@tachyon/engine/worktree/reviewNotes.js";
import type { ReviewMutationInputV1 } from "@tachyon/engine/runtime-api/reviewCommands.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  type WorktreeEvidence,
} from "@tachyon/engine/worktree/evidence.js";

/** t-232111 — capture k that zeros .md and almost zeros .css/.tsx. Ambiguity remains structural. */
export const REVIEW_NOTE_CAPTURE_K = 3;
export const REVIEW_COMMENT_CONTROLLER_ID = "tachyon.review";
/** The product scheme string. The one-diff-flow identifier lives only in extension.ts. */
export const REVIEW_DIFF_SCHEME = "tachyon-worktree";

export type ReviewNotePriority = "high" | "normal" | "low";

export type ReviewWorktreeRow = {
  agent: string;
  path: string;
  baseRef: string;
  workspaceHash: string;
};

export type ReviewUriFields = {
  scheme: string;
  path: string;
  query: string;
  fsPath?: string;
};

export type ReviewDiffTab = {
  original: ReviewUriFields;
  modified: ReviewUriFields;
};

export type ReviewDocumentLocation = {
  worktree: string;
  cwd: string;
  path: string;
  baseRef: string;
  workspaceHash: string;
  headRef?: string;
};

export type LiveThreadRef = {
  commentId: string;
};

export type RestorePlan = {
  restore: Array<{ commentId: string; note: ReviewNote }>;
  create: ReviewNote[];
  dispose: string[];
};

export type PromptNote = {
  path: string;
  line: number;
  body: string;
  priority: ReviewNotePriority;
  status?: ReviewNote["status"];
};

export interface ReviewCommentsHost {
  listWorktrees(): Promise<ReviewWorktreeRow[]>;
  viewNotes(worktree: string, k: number, workspaceHash: string): Promise<ReviewNote[]>;
  upsert(input: Extract<ReviewMutationInputV1, { action: "note.upsert" }>, workspaceHash: string): Promise<void>;
  hint(input: Extract<ReviewMutationInputV1, { action: "note.hint" }>, workspaceHash: string): Promise<void>;
  listAgentsForWorktree(cwd: string, workspaceHash: string): Promise<Array<{ name: string; detail?: string }>>;
  sendPrompt(agent: string, text: string, workspaceHash: string): Promise<void>;
  attachEvidence(workspaceHash: string, record: WorktreeEvidence): Promise<void>;
  resolveHead(cwd: string): Promise<string | undefined>;
  notify(message: string, kind: "info" | "warn" | "error"): void;
}

export function parseReviewUriQuery(query: string): { cwd?: string; ref?: string; empty: boolean } {
  const params = new URLSearchParams(query);
  const cwdRaw = params.get("cwd");
  const refRaw = params.get("ref");
  return {
    ...(cwdRaw !== null ? { cwd: decodeQueryValue(cwdRaw) } : {}),
    ...(refRaw !== null ? { ref: decodeQueryValue(refRaw) } : {}),
    empty: params.get("empty") === "1",
  };
}

/**
 * Compare two review URIs by purpose: scheme + path, and for the virtual scheme
 * cwd + ref + empty. Two URIs of the same file at different refs are not equal.
 * Never compare by accidental `toString()` equality.
 */
export function reviewUrisEqual(left: ReviewUriFields, right: ReviewUriFields): boolean {
  if (left.scheme !== right.scheme) return false;
  if (left.scheme === "file") {
    return filePathOf(left) === filePathOf(right);
  }
  if (left.scheme === REVIEW_DIFF_SCHEME) {
    const a = parseReviewUriQuery(left.query);
    const b = parseReviewUriQuery(right.query);
    return left.path === right.path && a.cwd === b.cwd && a.ref === b.ref && a.empty === b.empty;
  }
  return false;
}

/**
 * ONE path for both modified-side forms. A document is a review modified side
 * when it is the `modified` URI of a diff whose original uses the product
 * scheme, or (no-headRef door) a file: URI inside a known worktree checkout.
 * The base side is never returned.
 */
export function locateReviewModifiedDocument(
  uri: ReviewUriFields,
  worktrees: readonly ReviewWorktreeRow[],
  tabs: readonly ReviewDiffTab[],
): ReviewDocumentLocation | undefined {
  const asModified = tabs.find((tab) =>
    tab.original.scheme === REVIEW_DIFF_SCHEME && reviewUrisEqual(tab.modified, uri),
  );
  if (asModified) return locationFromModifiedUri(uri, worktrees);
  if (uri.scheme === "file") return locationFromModifiedUri(uri, worktrees);
  return undefined;
}

export function uniqueLocationsFromTabs(
  tabs: readonly ReviewDiffTab[],
  worktrees: readonly ReviewWorktreeRow[],
): ReviewDocumentLocation[] {
  const seen = new Set<string>();
  const out: ReviewDocumentLocation[] = [];
  for (const tab of tabs) {
    const location = locateReviewModifiedDocument(tab.modified, worktrees, [tab]);
    if (!location) continue;
    const key = `${location.workspaceHash}\0${location.worktree}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(location);
  }
  return out;
}

export function notesForDocumentPath(notes: readonly ReviewNote[], filePath: string): ReviewNote[] {
  return notes.filter((note) => note.lastPath === filePath || note.identity.path === filePath);
}

/**
 * Registry first. Existing threads are restored in place; only notes without a
 * live thread are created; live threads whose notes are gone are disposed.
 */
export function planThreadRestore(
  notesForPath: readonly ReviewNote[],
  liveOnDocument: readonly LiveThreadRef[],
): RestorePlan {
  const liveIds = new Set(liveOnDocument.map((thread) => thread.commentId));
  const noteIds = new Set(notesForPath.map((note) => note.identity.commentId));
  return {
    restore: notesForPath
      .filter((note) => liveIds.has(note.identity.commentId))
      .map((note) => ({ commentId: note.identity.commentId, note })),
    create: notesForPath.filter((note) => !liveIds.has(note.identity.commentId)),
    dispose: liveOnDocument
      .filter((thread) => !noteIds.has(thread.commentId))
      .map((thread) => thread.commentId),
  };
}

export function composeReviewNotesPrompt(input: {
  baseRef: string;
  notes: readonly PromptNote[];
}): string {
  const lines = [
    `REVIEW DO DIFF, ${input.notes.length} nota(s), base ${input.baseRef}.`,
    "",
  ];
  for (const note of input.notes) {
    const tag = note.status === "outdated" ? `${note.priority}, outdated` : note.priority;
    lines.push(`[${tag}] ${note.path}:${note.line}`);
    for (const bodyLine of note.body.split("\n")) {
      lines.push(`  ${bodyLine}`);
    }
    lines.push("");
  }
  lines.push("Cada correção cita file:line. Não mexa fora desses pontos.");
  return lines.join("\n");
}

export function promptNotesFromView(notes: readonly ReviewNote[]): PromptNote[] {
  return notes.map((note) => ({
    path: note.lastPath,
    line: note.lastLine,
    body: note.body,
    priority: "normal" as const,
    status: note.status,
  }));
}

export function reviewNotesEvidenceRecord(input: {
  targetAgent: string;
  atCommit: string;
  producedAt: string;
  id: string;
  baseRef: string;
  worktree: string;
  prompt: string;
  notes: readonly PromptNote[];
}): WorktreeEvidence {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    id: input.id,
    targetAgent: input.targetAgent,
    producer: "review",
    atCommit: input.atCommit,
    producedAt: input.producedAt,
    kind: "review-notes",
    severity: "info",
    summary: `Review notes batch: ${input.notes.length} note(s), base ${input.baseRef}`,
    detail: input.prompt,
    data: {
      worktree: input.worktree,
      baseRef: input.baseRef,
      notes: input.notes.map((note) => ({
        path: note.path,
        line: note.line,
        priority: note.priority,
        body: note.body,
        ...(note.status ? { status: note.status } : {}),
      })),
    },
  };
}

/** Engine ranges are 1-based; VS Code ranges are 0-based. */
export function noteRangeToVscode(range: { startLine: number; endLine: number }): { startLine: number; endLine: number } {
  return {
    startLine: Math.max(0, range.startLine - 1),
    endLine: Math.max(0, range.endLine - 1),
  };
}

export function vscodeRangeToHint(range: { startLine: number; endLine: number }): { startLine: number; endLine: number } {
  return { startLine: range.startLine + 1, endLine: range.endLine + 1 };
}

export function mintCommentId(now = Date.now(), random = Math.random): string {
  return `c${now.toString(36)}${Math.floor(random() * 1e9).toString(36)}`.slice(0, 128);
}

export function mintEvidenceId(producedAt: string, random = Math.random): string {
  return `ev-${producedAt}-r${Math.floor(random() * 1e9).toString(36)}`;
}

export function commentIdFromContextValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^tachyon-review:([^:]+)$/.exec(value);
  return match?.[1];
}

export function reviewThreadContextValue(commentId: string): string {
  return `tachyon-review:${commentId}`;
}

export type SendReviewNotesResult =
  | { sent: false; reason: "empty" | "no-agents" | "cancelled" }
  | { sent: true; agent: string; prompt: string; notes: PromptNote[]; evidence: "ok" | "failed" | "no-head"; evidenceId?: string };

export async function sendReviewNotesBatch(opts: {
  host: ReviewCommentsHost;
  location: ReviewDocumentLocation;
  pickAgent: (agents: Array<{ name: string; detail?: string }>) => Promise<string | undefined>;
  now?: () => Date;
}): Promise<SendReviewNotesResult> {
  const notes = await opts.host.viewNotes(opts.location.worktree, REVIEW_NOTE_CAPTURE_K, opts.location.workspaceHash);
  if (notes.length === 0) return { sent: false, reason: "empty" };
  const agents = await opts.host.listAgentsForWorktree(opts.location.cwd, opts.location.workspaceHash);
  if (agents.length === 0) return { sent: false, reason: "no-agents" };
  const agent = await opts.pickAgent(agents);
  if (!agent) return { sent: false, reason: "cancelled" };
  const promptNotes = promptNotesFromView(notes);
  const prompt = composeReviewNotesPrompt({ baseRef: opts.location.baseRef, notes: promptNotes });
  const producedAt = (opts.now ? opts.now() : new Date()).toISOString();
  const atCommit = await opts.host.resolveHead(opts.location.cwd);
  let evidenceState: "ok" | "failed" | "no-head" = "no-head";
  let evidenceId: string | undefined;
  if (!atCommit) {
    evidenceState = "no-head";
  } else {
    evidenceId = mintEvidenceId(producedAt);
    try {
      await opts.host.attachEvidence(opts.location.workspaceHash, reviewNotesEvidenceRecord({
        targetAgent: agent,
        atCommit,
        producedAt,
        id: evidenceId,
        baseRef: opts.location.baseRef,
        worktree: opts.location.worktree,
        prompt,
        notes: promptNotes,
      }));
      evidenceState = "ok";
    } catch {
      evidenceId = undefined;
      evidenceState = "failed";
    }
  }
  await opts.host.sendPrompt(agent, prompt, opts.location.workspaceHash);
  return {
    sent: true,
    agent,
    prompt,
    notes: promptNotes,
    evidence: evidenceState,
    ...(evidenceId ? { evidenceId } : {}),
  };
}

export function collectDiffTabsFromGroups(
  groups: ReadonlyArray<{ tabs: ReadonlyArray<{ input: unknown }> }>,
  isTextDiff: (input: unknown) => input is { original: { scheme: string; path: string; query: string; fsPath: string }; modified: { scheme: string; path: string; query: string; fsPath: string } },
): ReviewDiffTab[] {
  const tabs: ReviewDiffTab[] = [];
  for (const group of groups) {
    for (const tab of group.tabs) {
      if (!isTextDiff(tab.input)) continue;
      tabs.push({
        original: uriFields(tab.input.original),
        modified: uriFields(tab.input.modified),
      });
    }
  }
  return tabs;
}

export function uriFields(uri: { scheme: string; path: string; query: string; fsPath?: string }): ReviewUriFields {
  return {
    scheme: uri.scheme,
    path: uri.path,
    query: uri.query,
    ...(uri.fsPath !== undefined ? { fsPath: uri.fsPath } : {}),
  };
}

export function registerReviewComments(
  vs: typeof vscode,
  host: ReviewCommentsHost,
): vscode.Disposable {
  const controller = vs.comments.createCommentController(REVIEW_COMMENT_CONTROLLER_ID, "Tachyon Review");
  controller.options = {
    prompt: vs.l10n.t("Review note"),
    placeHolder: vs.l10n.t("Write a note on this line"),
  };

  type Live = {
    commentId: string;
    worktree: string;
    workspaceHash: string;
    thread: vscode.CommentThread;
    lastHint?: { startLine: number; endLine: number };
  };
  const live = new Map<string, Live>();
  let worktrees: ReviewWorktreeRow[] = [];
  const commentingRangesChanged = new vs.EventEmitter<void>();

  const isTextDiff = (input: unknown): input is vscode.TabInputTextDiff =>
    input instanceof vs.TabInputTextDiff;

  const tabs = (): ReviewDiffTab[] =>
    collectDiffTabsFromGroups(vs.window.tabGroups.all, isTextDiff);

  const refreshWorktrees = async (): Promise<ReviewWorktreeRow[]> => {
    worktrees = await host.listWorktrees();
    commentingRangesChanged.fire();
    return worktrees;
  };

  controller.commentingRangeProvider = {
    onDidChangeCommentingRanges: commentingRangesChanged.event,
    provideCommentingRanges(document) {
      const location = locateReviewModifiedDocument(uriFields(document.uri), worktrees, tabs());
      if (!location || document.lineCount < 1) return [];
      return [new vs.Range(0, 0, document.lineCount - 1, 0)];
    },
  } as vscode.CommentingRangeProvider;

  const author = (): vscode.CommentAuthorInformation => ({ name: vs.l10n.t("You") });

  const makeComment = (body: string, note?: ReviewNote): vscode.Comment => ({
    body,
    mode: vs.CommentMode.Preview,
    author: author(),
    ...(note?.status === "outdated"
      ? { label: note.outdatedReason ? vs.l10n.t("outdated — {0}", note.outdatedReason) : vs.l10n.t("outdated") }
      : {}),
  });

  const applyNoteToThread = (entry: Live, note: ReviewNote): void => {
    const converted = noteRangeToVscode(note.range);
    entry.thread.range = new vs.Range(converted.startLine, 0, converted.endLine, 0);
    entry.thread.comments = [makeComment(note.body, note)];
    entry.thread.label = note.status === "outdated"
      ? vs.l10n.t("outdated")
      : note.lastPath;
    entry.thread.contextValue = reviewThreadContextValue(note.identity.commentId);
    entry.thread.canReply = false;
    entry.lastHint = { startLine: note.range.startLine, endLine: note.range.endLine };
  };

  const createThreadFromNote = (uri: vscode.Uri, note: ReviewNote, workspaceHash: string): void => {
    const converted = noteRangeToVscode(note.range);
    const thread = controller.createCommentThread(
      uri,
      new vs.Range(converted.startLine, 0, converted.endLine, 0),
      [makeComment(note.body, note)],
    );
    const entry: Live = {
      commentId: note.identity.commentId,
      worktree: note.identity.worktree,
      workspaceHash,
      thread,
    };
    applyNoteToThread(entry, note);
    live.set(note.identity.commentId, entry);
  };

  const restoreVisible = async (): Promise<void> => {
    const rows = await refreshWorktrees();
    const open = tabs();
    const seenDocs = new Set<string>();
    for (const tab of open) {
      if (tab.original.scheme !== REVIEW_DIFF_SCHEME) continue;
      const location = locateReviewModifiedDocument(tab.modified, rows, [tab]);
      if (!location) continue;
      const docKey = `${location.workspaceHash}\0${location.worktree}\0${location.path}\0${tab.modified.scheme}\0${tab.modified.path}\0${tab.modified.query}\0${tab.modified.fsPath ?? ""}`;
      if (seenDocs.has(docKey)) continue;
      seenDocs.add(docKey);
      let notes: ReviewNote[] = [];
      try {
        notes = await host.viewNotes(location.worktree, REVIEW_NOTE_CAPTURE_K, location.workspaceHash);
      } catch {
        continue;
      }
      const forPath = notesForDocumentPath(notes, location.path);
      const liveOnDocument: Live[] = [];
      for (const entry of live.values()) {
        if (reviewUrisEqual(uriFields(entry.thread.uri), tab.modified)) liveOnDocument.push(entry);
      }
      const plan = planThreadRestore(forPath, liveOnDocument);
      for (const commentId of plan.dispose) {
        live.get(commentId)?.thread.dispose();
        live.delete(commentId);
      }
      for (const { commentId, note } of plan.restore) {
        const entry = live.get(commentId);
        if (entry) applyNoteToThread(entry, note);
      }
      const modifiedUri = openModifiedUri(vs, tab.modified);
      if (!modifiedUri) continue;
      for (const note of plan.create) {
        createThreadFromNote(modifiedUri, note, location.workspaceHash);
      }
    }
  };

  const createNote = async (reply: vscode.CommentReply): Promise<void> => {
    const rows = await refreshWorktrees();
    const location = locateReviewModifiedDocument(uriFields(reply.thread.uri), rows, tabs());
    if (!location || !reply.thread.range) {
      reply.thread.dispose();
      return;
    }
    const hint = vscodeRangeToHint({
      startLine: reply.thread.range.start.line,
      endLine: reply.thread.range.end.line,
    });
    const existingId = commentIdFromContextValue(reply.thread.contextValue);
    const commentId = existingId ?? mintCommentId();
    const body = existingId
      ? [...reply.thread.comments.map((comment) => typeof comment.body === "string" ? comment.body : comment.body.value), reply.text].join("\n\n")
      : reply.text;
    try {
      await host.upsert({
        action: "note.upsert",
        id: commentId,
        worktree: location.worktree,
        baseRef: location.baseRef,
        path: location.path,
        body,
        line: hint.startLine,
        k: REVIEW_NOTE_CAPTURE_K,
        ...(location.headRef !== undefined ? { headRef: location.headRef } : {}),
        hintRange: hint,
        endLine: hint.endLine,
      }, location.workspaceHash);
    } catch (error) {
      host.notify(vs.l10n.t("Could not save the review note: {0}", error instanceof Error ? error.message : String(error)), "error");
      if (!existingId) reply.thread.dispose();
      return;
    }
    const entry: Live = live.get(commentId) ?? {
      commentId,
      worktree: location.worktree,
      workspaceHash: location.workspaceHash,
      thread: reply.thread,
    };
    entry.thread = reply.thread;
    entry.lastHint = hint;
    live.set(commentId, entry);
    reply.thread.comments = [makeComment(body)];
    reply.thread.contextValue = reviewThreadContextValue(commentId);
    reply.thread.label = location.path;
    reply.thread.canReply = false;
  };

  const pushHints = (document: vscode.TextDocument): void => {
    for (const entry of live.values()) {
      if (!reviewUrisEqual(uriFields(entry.thread.uri), uriFields(document.uri))) continue;
      if (!entry.thread.range) continue;
      const hint = vscodeRangeToHint({
        startLine: entry.thread.range.start.line,
        endLine: entry.thread.range.end.line,
      });
      if (entry.lastHint && entry.lastHint.startLine === hint.startLine && entry.lastHint.endLine === hint.endLine) {
        continue;
      }
      entry.lastHint = hint;
      void host.hint({
        action: "note.hint",
        id: entry.commentId,
        worktree: entry.worktree,
        hintRange: hint,
      }, entry.workspaceHash).catch(() => {
        /* hint is a hint; the next review.view re-derives */
      });
    }
  };

  void restoreVisible();

  return vs.Disposable.from(
    commentingRangesChanged,
    controller,
    vs.commands.registerCommand("tachyon.review.createNote", (reply: vscode.CommentReply) => {
      void createNote(reply);
    }),
    vs.commands.registerCommand("tachyon.review.replyNote", (reply: vscode.CommentReply) => {
      void createNote(reply);
    }),
    vs.window.onDidChangeVisibleTextEditors(() => {
      void restoreVisible();
    }),
    vs.window.tabGroups.onDidChangeTabs(() => {
      void restoreVisible();
    }),
    vs.workspace.onDidChangeTextDocument((event) => {
      pushHints(event.document);
    }),
    { dispose: () => {
      for (const entry of live.values()) entry.thread.dispose();
      live.clear();
    } },
  );
}

function locationFromModifiedUri(
  uri: ReviewUriFields,
  worktrees: readonly ReviewWorktreeRow[],
): ReviewDocumentLocation | undefined {
  if (uri.scheme === REVIEW_DIFF_SCHEME) {
    const query = parseReviewUriQuery(uri.query);
    if (query.empty || !query.cwd) return undefined;
    const rel = uri.path.replace(/^\//, "");
    if (!rel || rel === "empty") return undefined;
    const row = worktrees.find((candidate) => pathsEqual(candidate.path, query.cwd!));
    if (!row) return undefined;
    return {
      worktree: row.agent,
      cwd: row.path,
      path: rel,
      baseRef: row.baseRef,
      workspaceHash: row.workspaceHash,
      ...(query.ref !== undefined ? { headRef: query.ref } : {}),
    };
  }
  if (uri.scheme === "file") {
    const fsPath = filePathOf(uri);
    const row = longestPrefixWorktree(worktrees, fsPath);
    if (!row) return undefined;
    const rel = relativePosix(row.path, fsPath);
    if (!rel) return undefined;
    return {
      worktree: row.agent,
      cwd: row.path,
      path: rel,
      baseRef: row.baseRef,
      workspaceHash: row.workspaceHash,
    };
  }
  return undefined;
}

function filePathOf(uri: ReviewUriFields): string {
  return uri.fsPath ?? uri.path;
}

function pathsEqual(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function longestPrefixWorktree(worktrees: readonly ReviewWorktreeRow[], fsPath: string): ReviewWorktreeRow | undefined {
  const needle = normalizePath(fsPath);
  let best: ReviewWorktreeRow | undefined;
  let bestLen = 0;
  for (const row of worktrees) {
    const prefix = normalizePath(row.path);
    if (needle === prefix || needle.startsWith(`${prefix}/`)) {
      if (prefix.length > bestLen) {
        best = row;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

function relativePosix(root: string, fsPath: string): string | undefined {
  const prefix = normalizePath(root);
  const full = normalizePath(fsPath);
  if (full === prefix) return undefined;
  if (!full.startsWith(`${prefix}/`)) return undefined;
  const rawRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const rawFull = fsPath.replace(/\\/g, "/");
  const sliced = rawFull.slice(rawRoot.length).replace(/^\/+/, "");
  return sliced.length > 0 ? sliced : undefined;
}

function decodeQueryValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function openModifiedUri(vs: typeof vscode, fields: ReviewUriFields): vscode.Uri | undefined {
  if (fields.scheme === "file") {
    const fsPath = fields.fsPath ?? fields.path;
    return vs.Uri.file(fsPath);
  }
  if (fields.scheme === REVIEW_DIFF_SCHEME) {
    return vs.Uri.from({ scheme: fields.scheme, path: fields.path, query: fields.query });
  }
  return undefined;
}

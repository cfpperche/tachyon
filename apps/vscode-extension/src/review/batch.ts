/**
 * SDD 511 send-batch helpers, kept after SDD 513 retired CommentController.
 *
 * Prompt composition, evidence, and the one-prompt send. No URI, no thread,
 * no vscode.comments. The Tachyon review tab is the surface.
 */
import type { ReviewNote } from "@tachyon/engine/worktree/reviewNotes.js";
import type { ReviewMutationInputV1 } from "@tachyon/engine/runtime-api/reviewCommands.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  type WorktreeEvidence,
} from "@tachyon/engine/worktree/evidence.js";

/** t-232111 — capture k that zeros .md and almost zeros .css/.tsx. Ambiguity remains structural. */
export const REVIEW_NOTE_CAPTURE_K = 3;

export type ReviewNotePriority = "high" | "normal" | "low";

export type ReviewWorktreeRow = {
  agent: string;
  path: string;
  baseRef: string;
  workspaceHash: string;
};

export type ReviewDocumentLocation = {
  worktree: string;
  cwd: string;
  path: string;
  baseRef: string;
  workspaceHash: string;
  headRef?: string;
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

export function mintCommentId(now = Date.now(), random = Math.random): string {
  return `c${now.toString(36)}${Math.floor(random() * 1e9).toString(36)}`.slice(0, 128);
}

export function mintEvidenceId(producedAt: string, random = Math.random): string {
  return `ev-${producedAt}-r${Math.floor(random() * 1e9).toString(36)}`;
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

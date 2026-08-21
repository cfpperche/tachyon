/**
 * SDD 513 fatia 2 — host ↔ review-screen envelope.
 *
 * The screen consumes types fatia 1 already named. It does not invent a query
 * verb, a line kind, or a hunk format. `review.diff` is the one-path hunk door;
 * the file list is the existing ChangedFile[] from the worktree-review payload.
 */
import type { ChangedFile } from "@tachyon/engine/worktree/review.js";
import type { ReviewDiffFileV1 } from "@tachyon/engine/runtime-api/reviewProjection.js";
import type { ReviewNote } from "@tachyon/engine/worktree/reviewNotes.js";
import { READY, readyMessage, type ReadyMessage } from "../shared/ready";

export { READY, readyMessage, type ReadyMessage };

export const REVIEW = "review" as const;
export const REVIEW_ERROR = "reviewError" as const;

export interface ReviewAgent {
  name: string;
  detail?: string;
}

export type ReviewBinaryFamily = "raster" | "svg" | "pdf" | "model";
export interface ReviewBinarySide { side: "base" | "current"; label: string; uri: string }
export interface ReviewBinaryAsset { family: ReviewBinaryFamily; sides: ReviewBinarySide[] }

/**
 * Everything the screen needs to paint. The host (fatia 3) fills this from
 * ChangedFile[] + review.view + one review.diff. Preview injects the same shape.
 */
export interface ReviewVM {
  worktree: string;
  baseRef: string;
  currentLabel: string;
  headRef?: string;
  k: number;
  files: ChangedFile[];
  selectedPath: string | null;
  diff?: ReviewDiffFileV1 | null;
  binaryAsset?: ReviewBinaryAsset;
  diffLoading?: boolean;
  notes: ReviewNote[];
  agents: ReviewAgent[];
  error?: string;
}

export interface ReviewMessage {
  type: typeof REVIEW;
  vm: ReviewVM;
}

export interface ReviewErrorMessage {
  type: typeof REVIEW_ERROR;
  message: string;
}

export type ReviewHostMessage = ReviewMessage | ReviewErrorMessage;

/**
 * Webview → host. `review.diff` is the named door (one path). Mutations and
 * the batch send are requests; the host owns minting, mutate, and attach_evidence.
 */
export type ReviewAction =
  | ReadyMessage
  | { type: "review.diff"; path: string }
  | { type: "review.upsertNote"; path: string; line: number; body: string }
  | { type: "review.sendBatch"; agent: string };

export const reviewMessage = (vm: ReviewVM): ReviewMessage => ({ type: REVIEW, vm });
export const reviewErrorMessage = (message: string): ReviewErrorMessage => ({ type: REVIEW_ERROR, message });

export const selectReviewFileAction = (path: string): ReviewAction => ({ type: "review.diff", path });
export const upsertReviewNoteAction = (path: string, line: number, body: string): ReviewAction => ({
  type: "review.upsertNote",
  path,
  line,
  body,
});
export const sendReviewBatchAction = (agent: string): ReviewAction => ({ type: "review.sendBatch", agent });

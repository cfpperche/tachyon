import crypto from "node:crypto";
import type { ArtifactRef, Task, TaskPriority, TaskUpdateInput } from "@tachyon/shared/tasks/types.js";
import type { TaskDetailReadResult } from "./TaskDetailStore.js";

/**
 * spec 339 (T4) — the pure, DOM-free "risk center" decisions the Task Studio panel (T5) depends on: the
 * body-hash anchoring model (which of load/reimport/read-only applies) and dirty-field patch composition
 * (proving untouched/board-owned fields are never sent). Nothing here touches the filesystem — every
 * dependency (task, sidecar read result, dirty flags) is passed in, so this is unit-testable in isolation.
 */

export function hashBody(body: string): string {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

export type AnchorAction = "load" | "reimport" | "read-only";

export interface AnchorDecision {
  action: AnchorAction;
  reason: string;
}

/**
 * The authoring-truth model (spec F1/F2/F15/F18): sidecar exists AND its bodyHash matches the CURRENT
 * `task.body` → load it (the doc is the richer rendering of the current body). Otherwise — no sidecar, or
 * the body changed externally since the sidecar was written (an agent's `update_task`) — reimport from
 * `task.body`; the external edit always wins. A malformed or unknown/newer schemaVersion sidecar is
 * fail-closed read-only: never reimported, never overwritten by a later `write()` without explicit
 * recovery (scalar task edits still go through `TaskStore` and are unaffected).
 */
export function decideAnchor(task: Task, read: TaskDetailReadResult): AnchorDecision {
  if (read.status === "malformed") return { action: "read-only", reason: read.error };
  if (read.status === "missing") return { action: "reimport", reason: "no sidecar yet" };
  const currentHash = hashBody(task.body ?? "");
  if (read.detail.bodyHash === currentHash) return { action: "load", reason: "sidecar matches the current body" };
  return { action: "reimport", reason: "task.body changed since the sidecar was written" };
}

export interface StudioFieldValues {
  title: string;
  kind?: string | null;
  priority?: TaskPriority | null;
  assignee?: string | null;
  deps?: string[] | null;
  artifact_refs?: ArtifactRef[] | null;
}

export interface DirtyFields {
  title?: boolean;
  kind?: boolean;
  priority?: boolean;
  assignee?: boolean;
  deps?: boolean;
  artifact_refs?: boolean;
}

export interface ComposeDirtyPatchOptions {
  /** the newly-serialized body, present only when the rich doc itself was dirty at Save time. `null` clears
   *  it (an emptied-out doc) — `TaskStore` rejects an empty STRING body outright (`boundedString` requires
   *  non-empty), so an empty derived markdown must be converted to `null` before reaching this option. */
  body?: string | null;
  /** CAS precondition — the `updatedAt` the Studio last loaded/refreshed against. */
  expectUpdatedAt?: string;
}

/**
 * Composes the dirty-field patch for `update_task` (spec F4): EXCLUSIVELY the fields the user actually
 * edited (per `dirty`) plus `body` when the doc was dirty — NEVER `status`/`rank` (not representable by
 * this function's inputs at all — proof by construction) and never a field the caller didn't mark dirty,
 * even if `values` carries a fresher value received via live fan-out while the Studio was open.
 */
export function composeDirtyPatch(values: StudioFieldValues, dirty: DirtyFields, opts: ComposeDirtyPatchOptions = {}): TaskUpdateInput {
  const patch: TaskUpdateInput = {};
  if (dirty.title) patch.title = values.title;
  if (dirty.kind) patch.kind = values.kind ?? null;
  if (dirty.priority) patch.priority = values.priority ?? null;
  if (dirty.assignee) patch.assignee = values.assignee ?? null;
  if (dirty.deps) patch.deps = values.deps ?? null;
  if (dirty.artifact_refs) patch.artifact_refs = values.artifact_refs ?? null;
  if (opts.body !== undefined) patch.body = opts.body;
  if (opts.expectUpdatedAt !== undefined) patch.expect = { updatedAt: opts.expectUpdatedAt };
  return patch;
}

/** Whether a composed patch would actually change anything (no dirty fields, no dirty body). Callers should
 * skip the `update_task` round-trip entirely when this is true (a no-op Save). */
export function isEmptyPatch(patch: TaskUpdateInput): boolean {
  const { expect: _expect, now: _now, ...rest } = patch;
  return Object.keys(rest).length === 0;
}

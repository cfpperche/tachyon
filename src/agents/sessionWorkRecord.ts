/**
 * t-e3aaae — what a restarted agent is working on, stated from durable record.
 *
 * A `session:new` restart mints a brand-new conversation: the pane scrollback is gone and so is
 * everything the agent was told after it was spawned. Until now the replacement brief was rebuilt
 * from the SPAWN row alone (`def.taskBrief` / `def.contract`), which is frozen at spawn time. So an
 * agent parked with `skip_contract_reason` and handed its real work afterwards — by a human typing
 * into its pane, or by a Task being assigned to it on the board — came back with a brief that said
 * nothing about that work, and two facts went missing at once:
 *
 *  1. WHAT it was doing. Measured: `claude-opus5` restarted graceful+new, read a brief containing
 *     only its own name and the doorbell guidance, and recovered `t-5bfb72` by scanning the board
 *     for `assignee == me && status == active` — an inference, not a handoff, and one that silently
 *     picks the wrong task the moment two are assigned.
 *  2. WHERE it was allowed to do it. The same restart said nothing about isolation, and the agent
 *     committed straight to the primary checkout although its (pane-delivered, now-lost)
 *     instructions had required an isolated worktree.
 *
 * This module renders both as explicit record. It is pure and table-testable: the manager supplies
 * the facts, this decides only how they read. Nothing here infers — an empty assignment list is
 * rendered as an empty assignment list, and says so.
 */

import { containsUnsafeFramingCharacter } from "../config/framingSafety.js";

/** One board Task currently assigned to the restarted agent, as the store holds it. */
export interface AssignedTaskRecord {
  id: string;
  title: string;
  status: string;
  priority?: number;
  body?: string;
}

/** Where this session is allowed to change files, from the durable worktree record (or its absence). */
export type SessionIsolation =
  | { kind: "worktree"; path: string; branch: string }
  | { kind: "shared"; cwd: string };

export interface SessionWorkRecord {
  isolation: SessionIsolation;
  /** Tasks assigned to this agent and in flight. Empty is a fact, not a missing value. */
  assigned: AssignedTaskRecord[];
}

/** Fixed delimiters — same design rule as the primer: agents recognize the section, never parse prose. */
export const SESSION_RECORD_OPEN = "── SESSION RESTART: WORK ON RECORD ──";
export const SESSION_RECORD_CLOSE = "── END SESSION RESTART ──";

/** Ids shown in the bounded startup-brief header before it collapses to a count. */
export const MAX_HEADER_TASK_IDS = 3;

function isolationLines(isolation: SessionIsolation): string[] {
  if (isolation.kind === "worktree") {
    return [
      `Isolation: git worktree ${isolation.path} on branch ${isolation.branch}.`,
      "Make every change here. Do not edit, commit to, or push the primary checkout from this session.",
    ];
  }
  return [
    `Isolation: none on record — this session runs in the shared checkout ${isolation.cwd}.`,
    "No worktree or branch was recorded for you, so nothing here authorizes committing to the trunk." +
      " If your work needs an isolated checkout, create one before you change tracked files; do not assume" +
      " an earlier conversation already granted that.",
  ];
}

function taskLines(task: AssignedTaskRecord): string[] {
  const priority = task.priority === undefined ? "" : `, priority ${task.priority}`;
  const head = `- ${task.id} — ${task.title} (status ${task.status}${priority})`;
  const body = task.body?.trim();
  return body ? [head, body] : [head];
}

function assignmentLines(assigned: AssignedTaskRecord[]): string[] {
  if (assigned.length === 0) {
    return [
      "Assigned work on record: none.",
      "Do not adopt work by scanning the board, the pins, or another agent's continuity." +
        " Wait for an explicit assignment.",
    ];
  }
  const heading = assigned.length === 1
    ? "Assigned work on record (1 task). This is your task; you do not need to look it up:"
    : `Assigned work on record (${assigned.length} tasks, all of them yours — say which one you are taking before you start):`;
  return [heading, ...assigned.flatMap(taskLines)];
}

/**
 * Render the record block appended to a restarted agent's brief. Lossless: task bodies are passed
 * through in full (the brief-file diversion, not truncation, keeps the pane payload small).
 */
export function renderSessionWorkRecord(record: SessionWorkRecord): string {
  const facts = [
    record.isolation.kind === "worktree" ? record.isolation.path : record.isolation.cwd,
    ...(record.isolation.kind === "worktree" ? [record.isolation.branch] : []),
    ...record.assigned.flatMap((task) => [task.id, task.title, task.status]),
  ];
  if (facts.some(containsUnsafeFramingCharacter)) {
    throw new Error("session work record facts must not contain control characters");
  }
  return [
    SESSION_RECORD_OPEN,
    "This session was restarted with a NEW conversation. The previous one is not available to you," +
      " and nothing below came from it — every line is durable record.",
    ...isolationLines(record.isolation),
    ...assignmentLines(record.assigned),
    SESSION_RECORD_CLOSE,
  ].join("\n");
}

/** Bounded projection of the record for the startup-brief header (content-free beyond ids). */
export function sessionRecordManifest(record: SessionWorkRecord): {
  isolation: "worktree" | "shared";
  assignedTaskIds: string[];
  assignedCount: number;
} {
  return {
    isolation: record.isolation.kind,
    assignedTaskIds: record.assigned.slice(0, MAX_HEADER_TASK_IDS).map((task) => task.id),
    assignedCount: record.assigned.length,
  };
}

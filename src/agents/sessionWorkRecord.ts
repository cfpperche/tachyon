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
import type { AssignedTaskRecord, AssignmentSelection, StaleContractReference } from "./assignmentSelection.js";

export type { AssignedTaskRecord };

/** Where this session is allowed to change files, from the durable worktree record (or its absence). */
export type SessionIsolation =
  | { kind: "worktree"; path: string; branch: string }
  | { kind: "shared"; cwd: string };

export interface SessionWorkRecord {
  /**
   * t-7f3009 — which launch this record describes. A restart and a spawn state DIFFERENT facts: only
   * a restart lost a conversation. Omitted means `restart`, so every pre-existing caller renders
   * exactly what it rendered before.
   */
  launch?: SessionLaunchKind;
  isolation: SessionIsolation;
  /**
   * t-9d250c — ONE current task and a queue, not a list to choose from. A restarted session that is
   * handed several equals picks one by feel, and two incidents showed which one it picks: the one the
   * frozen brief above still names, which is the one most likely to be finished.
   */
  assignment: AssignmentSelection;
  /** A substantive delegation brief exists independently of board ownership. */
  hasTaskBrief?: boolean;
  /**
   * t-9d250c — task ids the replayed spawn brief names that are NOT this session's live work, with
   * the status the store holds. Naming them is the whole point: the brief above is frozen at spawn
   * time, so an agent restarted after finishing it reads a contract for work that is over and has no
   * way to tell, short of checking the board itself — which is exactly the inference this record
   * exists to remove.
   */
  staleContractReferences?: StaleContractReference[];
}

/** Which launch handed this record to the session. */
export type SessionLaunchKind = "spawn" | "restart";

/** Fixed delimiters — same design rule as the primer: agents recognize the section, never parse prose. */
export const SESSION_RECORD_OPEN = "── SESSION RESTART: WORK ON RECORD ──";
export const SESSION_RECORD_CLOSE = "── END SESSION RESTART ──";

/**
 * t-7f3009 — the spawn pair. A separate anchor rather than a reworded shared one: the restart
 * delimiters are a landed recognition contract, and a fresh spawn must not be told it was restarted.
 * Each anchor names the launch it belongs to, so an agent still recognizes the section without
 * parsing prose.
 */
export const SPAWN_RECORD_OPEN = "── SESSION SPAWN: WORK ON RECORD ──";
export const SPAWN_RECORD_CLOSE = "── END SESSION SPAWN ──";

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

function assignmentLines(assignment: AssignmentSelection, launch: SessionLaunchKind, hasTaskBrief: boolean): string[] {
  if (!assignment.current) {
    return [
      "Assigned work on record: none.",
      hasTaskBrief
        ? "Execute the delegation brief above as delegated work. It does not create or assign a board task."
        : "Wait for an explicit assignment.",
      "Do not adopt work by scanning the board, the pins, or another agent's continuity.",
    ];
  }
  const lines = [
    `Your current task, read from the board at ${launch}. This is the contract for this session;` +
      " you do not need to look it up:",
    ...taskLines(assignment.current),
  ];
  if (assignment.queue.length > 0) {
    // Named, but never as work to start: the previous wording ("all of them yours — say which one you
    // are taking") made the choice the agent's, and a fresh session has nothing to choose with.
    lines.push(
      `Also assigned to you and still active (${assignment.queue.length}) — NOT your current task.` +
        " Finish or hand back the one above before starting any of these:",
      ...assignment.queue.map((task) => `- ${task.id} — ${task.title}`),
    );
  }
  return lines;
}

/**
 * What the frozen brief above still names, and what the board says about it now.
 *
 * Phrased as record rather than instruction where it can be — the agent is told the status, and told
 * not to reopen it only when the status positively means the work is over.
 */
function staleContractLines(references: StaleContractReference[] | undefined, launch: SessionLaunchKind): string[] {
  if (!references?.length) return [];
  const closed = references.filter((reference) => reference.closed);
  const lines = [
    launch === "spawn"
      // t-7f3009 — a spawn brief can be replayed verbatim from a previous launch, so "written when
      // this session was FIRST spawned" would be wrong here: this IS that spawn, and the brief is
      // still older than the board.
      ? "The task brief earlier in this document was authored before this launch and is not re-checked" +
        " against the board by whoever handed it to you. It names work that is no longer yours:"
      : "The task brief earlier in this document was written when this session was FIRST spawned and is" +
        " not re-checked against the board. It names work that is no longer yours:",
    ...references.map((reference) => `- ${reference.id} — status ${reference.status ?? "unknown"} on the board now`),
  ];
  if (closed.length > 0) {
    lines.push(
      `Do not reopen ${closed.map((reference) => reference.id).join(", ")}: that work is finished.` +
        " If the brief above describes it, the brief is stale and this record wins.",
    );
  }
  return lines;
}

/**
 * Render the record block appended to a restarted agent's brief. Lossless: task bodies are passed
 * through in full (the brief-file diversion, not truncation, keeps the pane payload small).
 */
export function renderSessionWorkRecord(record: SessionWorkRecord): string {
  const tasks = [...(record.assignment.current ? [record.assignment.current] : []), ...record.assignment.queue];
  const facts = [
    record.isolation.kind === "worktree" ? record.isolation.path : record.isolation.cwd,
    ...(record.isolation.kind === "worktree" ? [record.isolation.branch] : []),
    ...tasks.flatMap((task) => [task.id, task.title, task.status]),
  ];
  if (facts.some(containsUnsafeFramingCharacter)) {
    throw new Error("session work record facts must not contain control characters");
  }
  const launch: SessionLaunchKind = record.launch ?? "restart";
  return [
    launch === "spawn" ? SPAWN_RECORD_OPEN : SESSION_RECORD_OPEN,
    launch === "spawn"
      // A spawn lost no conversation, so it must not be told it did. What it shares with a restart is
      // the part that matters: nothing below is inferred, and the board is the authority.
      ? "This session is NEW. Nothing below came from an earlier conversation — every line is durable" +
        " record, read from the board at the moment you were launched."
      : "This session was restarted with a NEW conversation. The previous one is not available to you," +
        " and nothing below came from it — every line is durable record.",
    ...isolationLines(record.isolation),
    ...assignmentLines(record.assignment, launch, record.hasTaskBrief === true),
    ...staleContractLines(record.staleContractReferences, launch),
    launch === "spawn" ? SPAWN_RECORD_CLOSE : SESSION_RECORD_CLOSE,
  ].join("\n");
}

/** Bounded projection of the record for the startup-brief header (content-free beyond ids). */
export function sessionRecordManifest(record: SessionWorkRecord): {
  isolation: "worktree" | "shared";
  assignedTaskIds: string[];
  assignedCount: number;
} {
  const tasks = [...(record.assignment.current ? [record.assignment.current] : []), ...record.assignment.queue];
  return {
    isolation: record.isolation.kind,
    assignedTaskIds: tasks.slice(0, MAX_HEADER_TASK_IDS).map((task) => task.id),
    assignedCount: tasks.length,
  };
}

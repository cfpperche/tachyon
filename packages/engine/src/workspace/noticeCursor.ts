/**
 * t-b47fb2 fatia 2 — the per-agent delivery cursor that sits BESIDE the durable witness.
 *
 * ## Why a cursor at all
 *
 * `.tachyon/doorbells.jsonl` never loses a `notify_agent` (fatia 1 measured exactly that: the three
 * notices of 2026-08-17 survived only there). It is append-only and carries no read-receipt, so the
 * trail alone cannot answer "has this agent already been told?". Both halves of fatia 2 need that
 * answer for the same reason and would be actively harmful without it:
 *
 *  - **reconstitution** re-enqueues undelivered doorbells after an engine restart. With no cursor a
 *    boot would replay the whole trail — 3,283 rows here — turning every restart into a flood, which
 *    the card names as strictly worse than the loss it fixes.
 *  - **the end-of-turn drain hook** dumps pending notices into the agent's own session. With no cursor
 *    it would repeat the same notices at the end of every turn, forever.
 *
 * ## The custody rule, decided by the owner and stated here because it decides the code
 *
 * **The cursor advances when the notice is HANDED OVER, not when the agent confirms it read it.** An
 * agent that dies mid-hand-over loses that one hand-over. That is acceptable precisely because the
 * doorbell trail never loses anything: the cursor is CONVENIENCE, not custody, and `read_notices` can
 * still reach any row by passing an older `since`. Advancing only on confirmation would need a
 * confirmation channel that does not exist, and would make an agent that simply ignores its notices
 * accumulate them forever.
 *
 * Two writers share this file — the engine (in-process) and the Stop-hook drain (a separate `node`
 * process). Writes are atomic (temp + rename) and monotonic per agent, so the worst a lost update can
 * do is move a cursor BACK to an earlier hand-over, which re-delivers one notice. It can never skip an
 * undelivered one. Same trade, same reason: convenience, not custody.
 *
 * ## Fail open, and what "open" means here
 *
 * An unreadable or corrupt cursor file yields `undefined`, and every caller treats that as "restore
 * nothing / dump nothing" — i.e. exactly today's behaviour, which is the direction the card requires.
 * Failing the other way (treat corruption as "no cursor, so everything is pending") is the flood.
 */

import fs from "node:fs";
import path from "node:path";

export const NOTICE_CURSORS_REL_PATH = path.join(".tachyon", "notice-cursors.json");

export interface NoticeCursorFile {
  version: 1;
  /**
   * The trail position at the moment this workspace first established a cursor file.
   *
   * An agent with no cursor of its own is measured against this instead of against the beginning of
   * time. It is what makes the FIRST boot after an upgrade restore nothing (t-9f21ac's rule: the rows
   * already on disk are history, not triggers) while still letting a later boot restore a notice for
   * an agent that had never received one before the crash.
   */
  baseline: string;
  /** agent → the `at` of the newest doorbell already handed to that agent. */
  cursors: Record<string, string>;
}

export function noticeCursorPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, NOTICE_CURSORS_REL_PATH);
}

/** The stored file, or `undefined` when it is absent, unreadable, or not the shape we wrote. */
export function readNoticeCursorFile(workspaceRoot: string): NoticeCursorFile | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(noticeCursorPath(workspaceRoot), "utf8");
  } catch {
    return undefined;
  }
  return parseNoticeCursorFile(raw);
}

/** Pure parse, so the corruption cases are table-testable without touching a disk. */
export function parseNoticeCursorFile(raw: string): NoticeCursorFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  if (typeof record.baseline !== "string" || record.baseline.length === 0) return undefined;
  const rawCursors = record.cursors;
  if (typeof rawCursors !== "object" || rawCursors === null || Array.isArray(rawCursors)) return undefined;
  const cursors: Record<string, string> = {};
  for (const [agent, at] of Object.entries(rawCursors as Record<string, unknown>)) {
    // One damaged entry is not the whole answer, and dropping it is the fail-open direction: that
    // agent falls back to `baseline` rather than to the beginning of the trail.
    if (typeof at === "string" && at.length > 0) cursors[agent] = at;
  }
  return { version: 1, baseline: record.baseline, cursors };
}

/**
 * The position this agent is measured from: its own cursor when it has one, the workspace baseline
 * otherwise. Returns `undefined` only when there is no file at all — and no file means nothing is
 * pending, because a workspace with no cursor file has never handed anything over through this path.
 */
export function noticeCursorFor(file: NoticeCursorFile | undefined, agent: string): string | undefined {
  if (!file) return undefined;
  const own = file.cursors[agent];
  if (own === undefined) return file.baseline;
  return own > file.baseline ? own : file.baseline;
}

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

/**
 * Establish the cursor file if it is not already there, seeding `baseline` from the trail's tail.
 *
 * Called once per boot, BEFORE reconstitution reads it. Seeding at the tail is the whole of "a first
 * boot restores nothing": every row already on disk is at or before the baseline, so nothing is
 * pending for anybody until the next real `notify_agent` arrives.
 *
 * Returns the file in force, or `undefined` if it could not be written — in which case the caller
 * restores nothing, which is today's behaviour.
 */
export function ensureNoticeCursorFile(workspaceRoot: string, trailTail: string | undefined): NoticeCursorFile | undefined {
  const existing = readNoticeCursorFile(workspaceRoot);
  if (existing) return existing;
  const seeded: NoticeCursorFile = { version: 1, baseline: trailTail ?? new Date().toISOString(), cursors: {} };
  try {
    atomicWriteJson(noticeCursorPath(workspaceRoot), seeded);
  } catch {
    return undefined;
  }
  return seeded;
}

/**
 * Record that everything up to and including `at` has been handed to `agent`.
 *
 * Monotonic: an older `at` is ignored rather than written, so an out-of-order flush (the queue is
 * FIFO, but a retry can submit an older item after a newer one was already delivered) cannot rewind
 * the cursor. Best-effort by design — a cursor we could not write costs one re-delivery, and throwing
 * here would cost the delivery itself.
 */
export function advanceNoticeCursor(workspaceRoot: string, agent: string, at: string | undefined): void {
  if (!at) return;
  try {
    const file = readNoticeCursorFile(workspaceRoot) ?? { version: 1 as const, baseline: at, cursors: {} };
    const current = file.cursors[agent];
    if (current !== undefined && current >= at) return;
    atomicWriteJson(noticeCursorPath(workspaceRoot), { ...file, cursors: { ...file.cursors, [agent]: at } });
  } catch {
    /* best-effort: the witness still holds the row, and `read_notices` can still reach it */
  }
}

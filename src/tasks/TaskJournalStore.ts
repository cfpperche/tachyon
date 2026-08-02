import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TASK_ID_RE, type JournalEntry, type JournalMode, type JournalWindow } from "./types.js";

export const JOURNAL_TEXT_MAX_CODEPOINTS = 4000;
export const JOURNAL_MAX_BYTES = 256 * 1024;

/**
 * t-ab7708 — the ceiling a windowed journal read may spend, in UTF-8 bytes of serialized entries.
 *
 * BYTES, not entries, and this is the part that is easy to get wrong. Across the 747 journals in
 * this workspace a single entry runs from 139 to 4,127 characters, so "the last 10 entries" is
 * anywhere between 1KB and 40KB and bounds nothing. A byte ceiling bounds the cost; entry
 * granularity keeps it readable, because half an entry is not evidence.
 *
 * 4096 was measured, not chosen: replaying the 30 recorded get_task calls, it leaves 19 of them
 * untouched while cutting the worst call — 14,187 tokens of which 90.5% was journal — by 71%.
 */
export const JOURNAL_WINDOW_MAX_BYTES = 4096;

/**
 * Take the slice of a journal a caller asked for, and describe what was left behind.
 *
 * `tail` (the default read) walks BACKWARD from the newest entry while the byte budget holds:
 * journal is execution context, and for that the end is what matters. Pass `offset` to walk
 * forward from an arbitrary point instead, which is how a caller pages through the whole log
 * without asking for it all at once. `all` is the declared escape hatch and is never capped.
 *
 * An entry is never split, and a window is never empty while the journal is not: if the one entry
 * at the window's edge is larger than the whole budget it is returned anyway, over budget and
 * declared. Returning nothing while reporting a cap would hide content behind an accounting rule.
 */
export function sliceJournal(
  entries: JournalEntry[],
  options: { mode: JournalMode; offset?: number; maxBytes?: number } = { mode: "tail" },
): { entries: JournalEntry[]; window: JournalWindow } {
  const total = entries.length;
  const mode = options.mode;

  if (mode === "none") {
    return {
      entries: [],
      window: {
        mode,
        returned: 0,
        total,
        offset: 0,
        truncated: total > 0,
        ...(total > 0
          ? {
            note:
              `note: journal omitted (journal="none"); this task has ${total} ${plural(total)}. ` +
              `Request journal="tail" for the most recent, or journal="all" for every entry.`,
          }
          : {}),
      },
    };
  }

  if (mode === "all") {
    return { entries: [...entries], window: { mode, returned: total, total, offset: 0, truncated: false } };
  }

  const maxBytes = options.maxBytes ?? JOURNAL_WINDOW_MAX_BYTES;
  const requestedOffset = options.offset;

  if (requestedOffset !== undefined && requestedOffset >= total) {
    return {
      entries: [],
      window: {
        mode,
        returned: 0,
        total,
        offset: requestedOffset,
        truncated: total > 0,
        maxBytes,
        ...(total > 0
          ? {
            note:
              `note: journalOffset ${requestedOffset} is beyond the ${total} ${plural(total)} of this journal; ` +
              `request a lower offset, or journal="all" for every entry.`,
          }
          : {}),
      },
    };
  }

  const picked = requestedOffset === undefined
    ? takeBackwardFromEnd(entries, maxBytes)
    : takeForwardFrom(entries, requestedOffset, maxBytes);
  const returned = picked.length;
  const offset = requestedOffset === undefined ? total - returned : requestedOffset;
  const truncated = returned < total;
  const lastReturned = offset + returned;

  let note: string | undefined;
  if (truncated) {
    const range = `showing ${returned === 1 ? "entry" : "entries"} ${offset + 1}-${lastReturned} of ${total}`;
    note = lastReturned >= total
      // The window sits on the newest entries; everything withheld is older than it.
      ? `note: ${range} (the most recent, maxBytes=${maxBytes}); ` +
        `request journal="all" for every entry, or journalOffset=0 to page forward from the oldest.`
      : `note: ${range} (journalOffset=${offset}, maxBytes=${maxBytes}); ` +
        `request journalOffset=${lastReturned} for the next page, or journal="all" for every entry.`;
  }

  return { entries: picked, window: { mode, returned, total, offset, truncated, maxBytes, ...(note ? { note } : {}) } };
}

function takeBackwardFromEnd(entries: JournalEntry[], maxBytes: number): JournalEntry[] {
  const out: JournalEntry[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const size = entryBytes(entries[i]);
    if (out.length > 0 && used + size > maxBytes) break;
    out.unshift(entries[i]);
    used += size;
  }
  return out;
}

function takeForwardFrom(entries: JournalEntry[], offset: number, maxBytes: number): JournalEntry[] {
  const out: JournalEntry[] = [];
  let used = 0;
  for (let i = Math.max(0, offset); i < entries.length; i++) {
    const size = entryBytes(entries[i]);
    if (out.length > 0 && used + size > maxBytes) break;
    out.push(entries[i]);
    used += size;
  }
  return out;
}

function entryBytes(entry: JournalEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

function plural(count: number): string {
  return count === 1 ? "entry" : "entries";
}

export interface TaskJournalStoreOptions {
  maxTextCodePoints?: number;
  maxBytes?: number;
  now?: () => string;
}

export interface AppendJournalInput {
  author: string;
  text: string;
  now?: string;
}

export class JournalCapExceededError extends Error {
  readonly code = "JOURNAL_CAP_EXCEEDED";

  constructor(readonly currentCount: number, readonly currentBytes: number, readonly maxBytes: number) {
    super(`JOURNAL_CAP_EXCEEDED: journal cap exceeded (currentCount=${currentCount}, currentBytes=${currentBytes}, maxBytes=${maxBytes})`);
  }
}

export class TaskJournalStore {
  private readonly maxTextCodePoints: number;
  private readonly maxBytes: number;
  private readonly now: () => string;

  constructor(private readonly workspaceRoot: string, options: TaskJournalStoreOptions = {}) {
    this.maxTextCodePoints = options.maxTextCodePoints ?? JOURNAL_TEXT_MAX_CODEPOINTS;
    this.maxBytes = options.maxBytes ?? JOURNAL_MAX_BYTES;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  get dir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "tasks");
  }

  pathFor(taskId: string): string {
    assertTaskId(taskId);
    return path.join(this.dir, `${taskId}.journal`);
  }

  append(taskId: string, input: AppendJournalInput): JournalEntry {
    assertTaskId(taskId);
    const author = boundedString(input.author, "author", 64);
    const text = boundedString(input.text, "text", this.maxTextCodePoints);
    const existing = this.stats(taskId);
    const entry: JournalEntry = {
      id: mintJournalEntryId(),
      ts: input.now ?? this.now(),
      author,
      text,
    };
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (existing.bytes + lineBytes > this.maxBytes) {
      throw new JournalCapExceededError(existing.count, existing.bytes, this.maxBytes);
    }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.pathFor(taskId), line, { encoding: "utf8", flag: "a" });
    return entry;
  }

  read(taskId: string): JournalEntry[] {
    assertTaskId(taskId);
    let text: string;
    try {
      text = fs.readFileSync(this.pathFor(taskId), "utf8");
    } catch {
      return [];
    }
    const rawLines = text.split(/\n/);
    const entries: JournalEntry[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (!line) continue;
      try {
        const parsed = normalizeJournalEntry(JSON.parse(line));
        if (parsed) entries.push(parsed);
      } catch {
        if (i === rawLines.length - 1 || (i === rawLines.length - 2 && rawLines[rawLines.length - 1] === "")) continue;
        throw new Error(`corrupt journal line for '${taskId}'`);
      }
    }
    return entries.sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  }

  count(taskId: string): number {
    return this.read(taskId).length;
  }

  stats(taskId: string): { count: number; bytes: number } {
    assertTaskId(taskId);
    let bytes = 0;
    try {
      bytes = fs.statSync(this.pathFor(taskId)).size;
    } catch {
      return { count: 0, bytes: 0 };
    }
    return { count: this.read(taskId).length, bytes };
  }

  delete(taskId: string): void {
    try {
      fs.rmSync(this.pathFor(taskId), { force: true });
    } catch {
      // best-effort sidecar cleanup.
    }
  }
}

function mintJournalEntryId(): string {
  return `j-${crypto.randomBytes(6).toString("hex")}`;
}

function normalizeJournalEntry(input: unknown): JournalEntry | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Partial<JournalEntry>;
  if (typeof row.id !== "string" || typeof row.ts !== "string" || typeof row.author !== "string" || typeof row.text !== "string") return null;
  if (!/^j-[0-9a-f]{12}$/.test(row.id)) return null;
  // t-c2882f — `JOURNAL_TEXT_MAX_CODEPOINTS` is an APPEND bound, and `append` still enforces it.
  // Re-applying it here made an entry persisted under a looser cap throw out of `read`, and the throw
  // took the WHOLE task's journal with it (`read` reports a non-trailing throw as a corrupt line).
  // Reading returns what is on disk; structure is still checked, size is not.
  const author = row.author.trim();
  const text = row.text.trim();
  if (!author || !text) return null;
  return { id: row.id, ts: row.ts, author, text };
}

function assertTaskId(id: string): void {
  if (!TASK_ID_RE.test(id)) throw new Error(`invalid task id '${id}'`);
}

function boundedString(value: string, name: string, max: number): string {
  const out = value.trim();
  if (!out) throw new Error(`${name} must be non-empty`);
  if ([...out].length > max) throw new Error(`${name} must be at most ${max} code points`);
  return out;
}

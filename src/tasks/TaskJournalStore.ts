import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TASK_ID_RE, type JournalEntry } from "./types.js";

export const JOURNAL_TEXT_MAX_CODEPOINTS = 4000;
export const JOURNAL_MAX_BYTES = 256 * 1024;

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
  return {
    id: row.id,
    ts: row.ts,
    author: boundedString(row.author, "author", 64),
    text: boundedString(row.text, "text", JOURNAL_TEXT_MAX_CODEPOINTS),
  };
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

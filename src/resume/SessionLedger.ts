import fs from "node:fs";
import path from "node:path";
import type { ResumeRuntime } from "./adapters.js";

/**
 * Per-workspace session ledger (spec 209 / F29): `agentName -> SessionRecord`,
 * persisted to `.tachyon/sessions.json` so an agent's session id survives the
 * death of its process/window. Written at spawn (minted id) or first id-resolve
 * (capture runtimes). Tolerant of a missing OR corrupt file — a broken ledger
 * must never block activation, so it reads as empty rather than throwing
 * (unlike PinStore, where corruption is a user-facing error).
 */

export interface SessionRecord {
  runtime: ResumeRuntime;
  /** The CLI's session/thread id (minted by us or captured from the runtime). */
  sessionId: string;
  /** Absolute cwd the agent ran in — resume must respawn in the identical dir. */
  cwd: string;
  /** Raw spawn command (def.cmd) so resume re-passes the same flags (permission/sandbox/model). */
  cmd: string;
  /** Declared (tachyon.yml) vs ad-hoc — declared+autostart auto-resumes, others are offered. */
  declared: boolean;
  updatedAt: string;
}

type LedgerFile = { sessions?: Record<string, SessionRecord> };

export class SessionLedger {
  constructor(private readonly workspaceRoot: string) {}

  get path(): string {
    return path.join(this.workspaceRoot, ".tachyon", "sessions.json");
  }

  /** All records; empty on missing/corrupt/shape-mismatch (never throws). */
  all(): Map<string, SessionRecord> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.path, "utf8");
    } catch {
      return new Map();
    }
    try {
      const parsed = JSON.parse(raw) as LedgerFile;
      const sessions = parsed?.sessions;
      if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return new Map();
      return new Map(Object.entries(sessions).filter(([, r]) => isRecord(r)));
    } catch {
      return new Map();
    }
  }

  get(name: string): SessionRecord | undefined {
    return this.all().get(name);
  }

  /** Insert/replace one agent's record (timestamp stamped here). */
  record(name: string, rec: Omit<SessionRecord, "updatedAt"> & { updatedAt?: string }): void {
    const all = this.all();
    all.set(name, { ...rec, updatedAt: rec.updatedAt ?? new Date().toISOString() });
    this.write(all);
  }

  remove(name: string): void {
    const all = this.all();
    if (all.delete(name)) this.write(all);
  }

  private write(all: Map<string, SessionRecord>): void {
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    const sessions = Object.fromEntries(all);
    fs.writeFileSync(this.path, `${JSON.stringify({ sessions }, null, 2)}\n`, "utf8");
  }
}

function isRecord(r: unknown): r is SessionRecord {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return typeof o.sessionId === "string" && typeof o.cwd === "string" && typeof o.cmd === "string" && typeof o.runtime === "string";
}

import fs from "node:fs";
import path from "node:path";
import { adapterForRuntime, type ResumeRuntime } from "./adapters.js";
import { inferKind, type EntryKind } from "../config/loadConfig.js";

/**
 * Per-workspace session ledger (spec 209 + 211): `agentName -> SessionRecord`,
 * persisted to `.tachyon/sessions.json` so an agent survives the death of its
 * process/window. Tolerant of a missing OR corrupt file — a broken ledger must
 * never block activation, so it reads as empty rather than throwing.
 *
 * Spec 211 split the record into two concerns so a non-resumable row can't be
 * mistaken for a resumable one:
 *   - `def`    — how to RESTART the agent (every ad-hoc agent, incl. non-AI `sh`);
 *                also carries lineage (`parent`). Drives rehydration after a restart.
 *   - `resume` — how to RESUME the CONVERSATION (adapter-backed runtimes only).
 * Use `isResumable(record)` — NEVER "the row exists" — to decide resume affordances.
 */

/** How to reconstruct/restart an ad-hoc agent's definition after a host restart. */
export interface SessionDef {
  cmd: string; // the ORIGINAL spawn command (no minted-id injection)
  kind: EntryKind;
  instructions?: string;
  parent?: string; // lineage — who spawned it
}

/** How to resume the prior conversation — adapter-backed runtimes only. */
export interface SessionResume {
  runtime: ResumeRuntime;
  /** minted by us, or captured from the runtime (may be "" until first resolve). */
  sessionId: string;
}

export interface SessionRecord {
  /** present for every ad-hoc agent; absent for a declared agent's resume-only row. */
  def?: SessionDef;
  /** present only for adapter-backed runtimes. */
  resume?: SessionResume;
  /** absolute cwd the agent ran in — resume respawns here, transcript resolves here. */
  cwd: string;
  /** declared (tachyon.yml) vs ad-hoc — declared+autostart auto-resumes, others are offered. */
  declared: boolean;
  updatedAt: string;
}

/** A row may drive resume only when it has a runtime AND that runtime still has an adapter. */
export function isResumable(rec: SessionRecord): boolean {
  return !!rec.resume?.runtime && adapterForRuntime(rec.resume.runtime) !== undefined;
}

type LedgerFile = { sessions?: Record<string, unknown> };

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
      const out = new Map<string, SessionRecord>();
      for (const [name, r] of Object.entries(sessions)) {
        const rec = normalize(r);
        if (rec) out.set(name, rec);
      }
      return out;
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

/**
 * Accept the 211 shape, OR migrate a pre-211 flat record
 * (`{runtime, sessionId, cwd, cmd, declared}`) into it. Returns null on garbage.
 */
function normalize(r: unknown): SessionRecord | null {
  if (typeof r !== "object" || r === null) return null;
  const o = r as Record<string, unknown>;
  if (typeof o.cwd !== "string") return null;
  const declared = o.declared === true;
  const updatedAt = typeof o.updatedAt === "string" ? o.updatedAt : new Date(0).toISOString();

  // New (211) shape: a def and/or resume object.
  if (o.def !== undefined || o.resume !== undefined) {
    const def = parseDef(o.def);
    const resume = parseResume(o.resume);
    if (!def && !resume) return null;
    return { def, resume, cwd: o.cwd, declared, updatedAt };
  }

  // Pre-211 flat record → migrate.
  if (typeof o.cmd === "string" && typeof o.runtime === "string") {
    return {
      def: { cmd: o.cmd, kind: inferKind(o.cmd) },
      resume: { runtime: o.runtime as ResumeRuntime, sessionId: typeof o.sessionId === "string" ? o.sessionId : "" },
      cwd: o.cwd,
      declared,
      updatedAt,
    };
  }
  return null;
}

function parseDef(d: unknown): SessionDef | undefined {
  if (typeof d !== "object" || d === null) return undefined;
  const o = d as Record<string, unknown>;
  if (typeof o.cmd !== "string") return undefined;
  const kind: EntryKind = o.kind === "agent" || o.kind === "terminal" ? o.kind : inferKind(o.cmd);
  return {
    cmd: o.cmd,
    kind,
    ...(typeof o.instructions === "string" ? { instructions: o.instructions } : {}),
    ...(typeof o.parent === "string" ? { parent: o.parent } : {}),
  };
}

function parseResume(r: unknown): SessionResume | undefined {
  if (typeof r !== "object" || r === null) return undefined;
  const o = r as Record<string, unknown>;
  if (typeof o.runtime !== "string") return undefined;
  return { runtime: o.runtime as ResumeRuntime, sessionId: typeof o.sessionId === "string" ? o.sessionId : "" };
}

import fs from "node:fs";
import path from "node:path";
import type { PipelineRun } from "./runState.js";

/**
 * spec 230 — per-run durability. Each pipeline run is persisted to `.tachyon/runs/<id>.json` so it
 * survives a VS Code reload; the PipelineManager re-enters the first incomplete node on activation.
 * Tolerant of a missing/corrupt file (like SessionLedger) — persistence is best-effort and must never
 * block a run. Distinct from `.tachyon/sessions.json`: the run ledger owns the GRAPH state; the session
 * ledger owns the per-node agent sessions (tagged `def.pipeline` so the generic resume path skips them).
 */
export class RunLedger {
  constructor(private readonly workspaceRoot: string) {}

  get dir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "runs");
  }
  private file(runId: string): string {
    return path.join(this.dir, `${runId}.json`);
  }

  save(run: PipelineRun): void {
    try {
      this.writeAtomic(run);
    } catch {
      /* best-effort — the prior complete receipt remains intact on a progress-write failure */
    }
  }

  /** Required allocation-boundary write. Unlike routine progress persistence, failures propagate so
   * a quarantined worktree is never unlocked on the strength of an in-memory-only owner. */
  saveRequired(run: PipelineRun): void {
    this.writeAtomic(run);
  }

  private writeAtomic(run: PipelineRun): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const destination = this.file(run.id);
    const temporary = `${destination}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      fs.renameSync(temporary, destination);
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort temp cleanup */ }
    }
  }

  load(runId: string): PipelineRun | null {
    try {
      return parseRun(JSON.parse(fs.readFileSync(this.file(runId), "utf8")));
    } catch {
      return null;
    }
  }

  list(): PipelineRun[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: PipelineRun[] = [];
    for (const n of names) {
      const r = this.load(n.slice(0, -".json".length));
      if (r) out.push(r);
    }
    return out;
  }

  remove(runId: string): void {
    try {
      fs.rmSync(this.file(runId), { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Defensive parse of a persisted run (trust our own writes, but reject garbage rather than crash). */
function parseRun(v: unknown): PipelineRun | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.worktreeKey !== "string") return null;
  if (typeof o.pipeline !== "object" || o.pipeline === null) return null;
  if (typeof o.nodes !== "object" || o.nodes === null) return null;
  // spec 231 back-compat: an old row predates `input`/`summaries`. Normalize `summaries` to [] (the
  // state machine + node-prompt assembly assume the array exists); leave `input` undefined (input: none).
  if (!Array.isArray(o.summaries)) o.summaries = [];
  if (o.input !== undefined && typeof o.input !== "string") delete o.input;
  // Runs persisted before the allocation transaction existed had already started nodes; preserve
  // their historical ready state. New runs always persist an explicit boolean.
  if (typeof o.worktreeReady !== "boolean") o.worktreeReady = true;
  if (o.worktree !== undefined) {
    const worktree = o.worktree as Record<string, unknown>;
    if (typeof worktree !== "object" || worktree === null
      || typeof worktree.path !== "string"
      || typeof worktree.branch !== "string"
      || typeof worktree.tachyonCreatedBranch !== "boolean"
      || typeof worktree.baseRef !== "string"
      || typeof worktree.createdAt !== "string") return null;
  }
  return o as unknown as PipelineRun;
}

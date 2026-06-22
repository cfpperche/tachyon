import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * spec 245 — PROJECT HANDOFF: one shared, curated, git-tracked "state of the work" per workspace root, distinct
 * from per-agent continuity (241, which is per-agent thread recovery). Tachyon owns the orchestration
 * (read/write/surface/nudge); the PROJECT owns the artifact. Two lanes (codex-debated D4):
 *
 *   .tachyon/HANDOFF.md          — CANONICAL: human/owner-curated, full rewrite only, CAS-protected (a rewrite
 *                                  carries the revision it edited; a stale rewrite is rejected, never clobbers).
 *   .tachyon/handoff-notes.jsonl — PENDING:   append-only, atomic; EVERY agent may append a structured delta.
 *                                  Agents NEVER rewrite the canonical → zero markdown-merge conflict.
 *
 * "Pending" = notes appended AFTER the canonical's last rewrite (so a human distilling = rewriting the canonical
 * naturally clears the pending count, with no separate mark-distilled step in v1). Staleness is computed against
 * activity, not file mtime. This module is PURE helpers + thin fs; no `vscode` import (engine boundary, spec 233).
 */

export const HANDOFF_DEFAULT_REL_PATH = path.join(".tachyon", "HANDOFF.md");
export const HANDOFF_NOTES_REL_PATH = path.join(".tachyon", "handoff-notes.jsonl");

/** The 4-section template seeded on first write / offered when no canonical exists (D2/D6). */
export const HANDOFF_TEMPLATE = `## Current State

_What is true right now._

## Active Work

_What is in flight._

## Next Actions

_What to do next._

## Decisions & Gotchas

_Decisions made, and non-obvious traps._
`;

export type HandoffNoteKind = "completed" | "blocked" | "decision" | "gotcha" | "next";
const VALID_KINDS: ReadonlySet<string> = new Set(["completed", "blocked", "decision", "gotcha", "next"]);

export interface HandoffNote {
  ts: string;
  agent: string;
  kind: HandoffNoteKind;
  summary: string;
  evidence: string[];
}

export interface HandoffMeta {
  version: number;
  updated_at: string;
  updated_by: "human" | "agent" | "tachyon";
  [k: string]: unknown; // unknown/future fields preserved on rewrite
}

export interface Canonical {
  meta: HandoffMeta;
  body: string;
  /** content hash of the body — the CAS token a rewrite must echo */
  revision: string;
}

export type StalenessState = "fresh" | "needs_distill" | "possibly_stale" | "old";

export interface HandoffSnapshot {
  exists: boolean;
  body: string;
  meta: HandoffMeta | null;
  revision: string;
  pendingCount: number;
  staleness: StalenessState;
}

export type SetResult =
  | { ok: true; revision: string; path: string }
  | { ok: false; reason: "cas_mismatch"; current: string };

/** sha256(body) → short CAS token. PURE. */
export function revisionOf(body: string): string {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

/** Parse the notes JSONL; skip blank/partial/garbage lines and notes missing required fields. Unknown `kind`
 *  coerces to "next" (never drop an agent's note over a bad enum). PURE. */
export function parseNotes(text: string): HandoffNote[] {
  const out: HandoffNote[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const r = JSON.parse(s) as Partial<HandoffNote>;
      if (typeof r.agent !== "string" || typeof r.summary !== "string" || typeof r.ts !== "string") continue;
      out.push({
        ts: r.ts,
        agent: r.agent,
        kind: typeof r.kind === "string" && VALID_KINDS.has(r.kind) ? (r.kind as HandoffNoteKind) : "next",
        summary: r.summary,
        evidence: Array.isArray(r.evidence) ? r.evidence.filter((e): e is string => typeof e === "string") : [],
      });
    } catch {
      /* skip a non-JSON / partial line */
    }
  }
  return out;
}

/** Pending = notes strictly newer than the canonical's last rewrite (lexicographic ISO-8601 compare is correct
 *  for UTC timestamps). When the canonical was never written, every note is pending. PURE. */
export function pendingNotes(notes: HandoffNote[], canonicalUpdatedAt: string | null): HandoffNote[] {
  if (!canonicalUpdatedAt) return notes;
  return notes.filter((n) => n.ts > canonicalUpdatedAt);
}

/** Staleness from activity, NOT mtime (D6). Precedence: pending notes (most actionable) → activity-since-rewrite
 *  with no notes → age → fresh. `lastActivityAt`/`canonicalUpdatedAt` are ISO strings or null. PURE. */
export function computeStaleness(input: {
  pendingCount: number;
  canonicalUpdatedAt: string | null;
  lastActivityAt: string | null;
  now: Date;
  oldThresholdMs: number;
}): StalenessState {
  if (input.pendingCount > 0) return "needs_distill";
  if (!input.canonicalUpdatedAt) return "fresh"; // nothing curated AND no pending → nothing to do
  if (input.lastActivityAt && input.lastActivityAt > input.canonicalUpdatedAt) return "possibly_stale";
  const updatedMs = Date.parse(input.canonicalUpdatedAt);
  if (!Number.isNaN(updatedMs) && input.now.getTime() - updatedMs > input.oldThresholdMs) return "old";
  return "fresh";
}

/** Parse `---\n<yaml>\n---\n<body>`; a body-only file (no frontmatter) is treated as all-body (a hand-authored
 *  HANDOFF.md is valid). PURE. */
export function parseCanonical(raw: string): Canonical {
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!fm) {
    const body = raw.trim();
    return { meta: { version: 1, updated_at: "", updated_by: "human" }, body, revision: revisionOf(body) };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(fm[1]);
  } catch {
    const body = raw.trim();
    return { meta: { version: 1, updated_at: "", updated_by: "human" }, body, revision: revisionOf(body) };
  }
  const m = (typeof parsed === "object" && parsed && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  const body = (fm[2] ?? "").trim();
  return {
    meta: {
      ...m,
      version: typeof m.version === "number" ? m.version : 1,
      updated_at: typeof m.updated_at === "string" ? m.updated_at : "",
      updated_by: m.updated_by === "agent" || m.updated_by === "tachyon" ? m.updated_by : "human",
    },
    body,
    revision: revisionOf(body),
  };
}

export function serializeCanonical(meta: HandoffMeta, body: string): string {
  const yaml = stringifyYaml(meta).trimEnd();
  const b = body.trim();
  return `---\n${yaml}\n---\n\n${b}${b.endsWith("\n") || b === "" ? "" : "\n"}`;
}

/** spec 245 inc F — activity records of NEW work an agent must accumulate (since it was last nudged OR appended)
 *  before the handoff append-nudge fires again. Mirrors continuity's activity-lag idea (241) — a "did real work"
 *  floor so an already-logged (or just-nudged) idle agent isn't re-nudged for the same work. */
export const HANDOFF_NUDGE_LAG = 25;

/**
 * spec 245 inc F — the append-nudge gate (PURE). Nudge agent A only when BOTH hold: (1) it produced ≥ `lag` new
 * activity records since its per-agent anchor (the anchor advances on a nudge OR an append, so neither a fresh
 * append NOR a prior nudge re-fires for the same work — fixes the "re-nudge an idle agent that already logged or
 * judged nothing worth a note" fatigue), and (2) the per-workspace cooldown has elapsed (so N agents hitting the
 * lag at once don't spam one shared file). `cooldownMs === null` = disabled (`nudgeEvery: off`).
 */
export function shouldRemindHandoff(input: {
  curSeq: number;
  anchorSeq: number;
  lag: number;
  lastNudgeAt: number; // ms epoch; 0 = never nudged
  now: number;
  cooldownMs: number | null;
}): boolean {
  if (input.cooldownMs === null) return false; // nudgeEvery: off
  if (input.curSeq - input.anchorSeq < input.lag) return false; // not enough NEW work since last nudge/append
  if (input.lastNudgeAt > 0 && input.now - input.lastNudgeAt < input.cooldownMs) return false; // workspace cooldown
  return true;
}

export interface ProjectHandoffOptions {
  /** canonical path RELATIVE to the workspace root (tachyon.yml `handoff.path`); default `.tachyon/HANDOFF.md`. */
  canonicalRelPath?: string;
  now?: () => Date;
  /** a canonical older than this with no pending notes / activity reads "old" (D6). Default 14 days. */
  oldThresholdMs?: number;
}

const DEFAULT_OLD_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;

export class ProjectHandoffStore {
  private readonly now: () => Date;
  private readonly oldThresholdMs: number;
  readonly canonicalPath: string;
  readonly notesPath: string;

  constructor(workspaceRoot: string, opts: ProjectHandoffOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.oldThresholdMs = opts.oldThresholdMs ?? DEFAULT_OLD_THRESHOLD_MS;
    this.canonicalPath = path.join(workspaceRoot, opts.canonicalRelPath || HANDOFF_DEFAULT_REL_PATH);
    this.notesPath = path.join(workspaceRoot, HANDOFF_NOTES_REL_PATH);
  }

  /** Read the canonical handoff, or null when it doesn't exist yet (cold start). */
  readCanonical(): Canonical | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.canonicalPath, "utf8");
    } catch {
      return null;
    }
    return parseCanonical(raw);
  }

  /** Read + parse the pending-notes lane (best-effort; missing/unreadable → []). */
  readNotes(): HandoffNote[] {
    try {
      return parseNotes(fs.readFileSync(this.notesPath, "utf8"));
    } catch {
      return [];
    }
  }

  /** Append ONE structured note atomically (O_APPEND; rows are small). Stamps ts when absent. All agents may call. */
  appendNote(note: { agent: string; kind?: string; summary: string; evidence?: string[] }): HandoffNote {
    const row: HandoffNote = {
      ts: this.now().toISOString(),
      agent: note.agent,
      kind: typeof note.kind === "string" && VALID_KINDS.has(note.kind) ? (note.kind as HandoffNoteKind) : "next",
      summary: note.summary,
      evidence: Array.isArray(note.evidence) ? note.evidence.filter((e): e is string => typeof e === "string") : [],
    };
    fs.mkdirSync(path.dirname(this.notesPath), { recursive: true });
    fs.appendFileSync(this.notesPath, `${JSON.stringify(row)}\n`, "utf8");
    return row;
  }

  /**
   * Rewrite the canonical handoff. CAS: `expectedRevision` must match the CURRENT body's revision, or the write is
   * rejected (returns the current body so the caller can re-read + retry). A first write (no canonical yet) accepts
   * any expectedRevision incl. "" / undefined. Atomic (tmp + rename).
   */
  setCanonical(body: string, expectedRevision: string | undefined, updatedBy: "human" | "agent" | "tachyon" = "human"): SetResult {
    const current = this.readCanonical();
    if (current && expectedRevision !== undefined && expectedRevision !== "" && expectedRevision !== current.revision) {
      return { ok: false, reason: "cas_mismatch", current: current.body };
    }
    const meta: HandoffMeta = {
      ...(current?.meta ?? {}),
      version: 1,
      updated_at: this.now().toISOString(),
      updated_by: updatedBy,
    };
    const text = serializeCanonical(meta, body);
    fs.mkdirSync(path.dirname(this.canonicalPath), { recursive: true });
    const tmp = `${this.canonicalPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, this.canonicalPath);
    return { ok: true, revision: revisionOf(body.trim()), path: this.canonicalPath };
  }

  /** A read-only snapshot for the Bridge (`get`) + the sidebar panel: canonical + pending count + staleness. */
  snapshot(lastActivityAt: string | null = null): HandoffSnapshot {
    const canonical = this.readCanonical();
    const notes = this.readNotes();
    const pending = pendingNotes(notes, canonical?.meta.updated_at || null);
    const staleness = computeStaleness({
      pendingCount: pending.length,
      canonicalUpdatedAt: canonical?.meta.updated_at || null,
      lastActivityAt,
      now: this.now(),
      oldThresholdMs: this.oldThresholdMs,
    });
    return {
      exists: !!canonical,
      body: canonical?.body ?? "",
      meta: canonical?.meta ?? null,
      revision: canonical?.revision ?? "",
      pendingCount: pending.length,
      staleness,
    };
  }
}

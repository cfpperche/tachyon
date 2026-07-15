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
  updated_at: string; // when the canonical was last WRITTEN (staleness/age + display)
  updated_by: "human" | "agent" | "tachyon";
  /** inc G — the DISTILL WATERMARK: notes with ts > this are still pending. Advances ONLY when a distiller declares
   *  "I folded notes up to ts X" (set's `distilledThrough`), NOT on wall-clock — so a note appended AFTER the
   *  distiller read `pending` but BEFORE the set stays pending (codex BLOCK: a set must only clear notes it saw). */
  distilled_through?: string;
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
  /** the pending note ROWS (oldest→newest) — what an agent reads to DISTILL into the canonical (inc G); the
   *  single source for both the Bridge `get` tool and the panel (DRY — one pending rule). */
  pending: HandoffNote[];
  staleness: StalenessState;
}

export type SetResult =
  | { ok: true; revision: string; path: string }
  | { ok: false; reason: "cas_mismatch"; current: string };

export interface EnsureResult {
  created: boolean;
  path: string;
}

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

/** Pending = notes strictly newer than the distill WATERMARK (inc G — the ts through which notes have been folded
 *  into the canonical; `meta.distilled_through`). Lexicographic ISO-8601 compare is correct for UTC timestamps.
 *  A falsy watermark (never distilled / no canonical) ⇒ every note is pending. PURE. */
export function pendingNotes(notes: HandoffNote[], watermark: string | null): HandoffNote[] {
  if (!watermark) return notes;
  return notes.filter((n) => n.ts > watermark);
}

/** inc G (codex re-review) — compute the new distill watermark, FORWARD-ONLY. `next` undefined/"" → keep `prev`
 *  (a non-distilling rewrite preserves pending); a malformed ts → keep `prev`; a value not strictly newer than
 *  `prev` → keep `prev` (never regress = never resurrect distilled notes). Only a valid ts > `prev` advances. PURE. */
/** The EXACT shape `Date#toISOString` writes a 4-digit-year UTC ts in — the form every handoff note ts uses. The
 *  regex pins it (codex: round-trip alone still accepts JS extended-year strings like `+010000-…` that sort wrong). */
const CANONICAL_NOTE_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function advanceWatermark(prev: string | undefined, next: string | undefined): string | undefined {
  // STRICT canonical ISO-UTC only — the exact shape note ts are written in, so the lexical compare in pendingNotes
  // is sound. Date.parse is too lax (RFC/locale dates) and a bare round-trip still lets extended-year strings
  // through; the regex + round-trip together pin it to `YYYY-MM-DDTHH:mm:ss.sssZ`. (codex re-review ×2)
  if (typeof next !== "string" || !CANONICAL_NOTE_TS.test(next)) return prev;
  let canonical: string;
  try { canonical = new Date(next).toISOString(); } catch { return prev; }
  if (canonical !== next) return prev;
  if (prev && next <= prev) return prev; // never regress
  return next;
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
   *
   * `distilledThrough` (inc G) ADVANCES the distill watermark — pass the latest pending-note ts the distiller
   * actually folded in (from get's `pending_through`); notes newer than it stay pending (a concurrent append isn't
   * lost). OMITTED ⇒ the watermark is PRESERVED unchanged (a plain body rewrite / template creation distills
   * nothing). So pending only clears for the notes the distiller declared it saw.
   */
  setCanonical(body: string, expectedRevision: string | undefined, updatedBy: "human" | "agent" | "tachyon" = "human", distilledThrough?: string): SetResult {
    const current = this.readCanonical();
    if (current && expectedRevision !== undefined && expectedRevision !== "" && expectedRevision !== current.revision) {
      return { ok: false, reason: "cas_mismatch", current: current.body };
    }
    const meta: HandoffMeta = {
      ...(current?.meta ?? {}),
      version: 1,
      updated_at: this.now().toISOString(),
      updated_by: updatedBy,
      // Watermark advances FORWARD-ONLY and only for a well-formed ts (codex re-review): undefined/"" → preserve;
      // an older or malformed value → preserve (never regress = never resurrect distilled notes; never let garbage
      // clear too much). Only a valid ts strictly newer than the current watermark advances it.
      distilled_through: advanceWatermark(current?.meta.distilled_through as string | undefined, distilledThrough),
    };
    const text = serializeCanonical(meta, body);
    fs.mkdirSync(path.dirname(this.canonicalPath), { recursive: true });
    const tmp = `${this.canonicalPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, this.canonicalPath);
    return { ok: true, revision: revisionOf(body.trim()), path: this.canonicalPath };
  }

  /**
   * Materialize a first canonical without ever replacing an incumbent.  A completed temp file is hard-linked
   * into place, so concurrent shell ensures converge and a Bridge/human write that wins the race is preserved.
   */
  ensureCanonical(body: string, updatedBy: "human" | "agent" | "tachyon" = "human"): EnsureResult {
    if (fs.existsSync(this.canonicalPath)) return { created: false, path: this.canonicalPath };
    const meta: HandoffMeta = {
      version: 1,
      updated_at: this.now().toISOString(),
      updated_by: updatedBy,
    };
    const text = serializeCanonical(meta, body);
    fs.mkdirSync(path.dirname(this.canonicalPath), { recursive: true });
    const tmp = `${this.canonicalPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
      try {
        fs.linkSync(tmp, this.canonicalPath);
        return { created: true, path: this.canonicalPath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return { created: false, path: this.canonicalPath };
        }
        throw error;
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* the temp may not have been created */ }
    }
  }

  /** A read-only snapshot for the Bridge (`get`) + the sidebar panel: canonical + pending count + staleness. */
  snapshot(lastActivityAt: string | null = null): HandoffSnapshot {
    const canonical = this.readCanonical();
    const notes = this.readNotes();
    // inc G — pending is measured against the DISTILL WATERMARK (distilled_through), not the write time, so a
    // concurrent append during a distill isn't silently cleared. `updated_at` still drives staleness age below.
    const pending = pendingNotes(notes, (canonical?.meta.distilled_through as string | undefined) || null);
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
      pending,
      staleness,
    };
  }
}

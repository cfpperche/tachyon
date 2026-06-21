import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * spec 241 — per-agent CONTINUITY: the agent's curated working memory (what it was doing, decided, and
 * plans next), so it survives a compaction / `/clear` / new session / restart and is back in its head on
 * resume. One markdown file per agent with YAML frontmatter Tachyon owns + a body the agent writes:
 *
 *   .tachyon/continuity/<agent>.md
 *
 * It is NOT the role doc (216: static task contract), NOT notes/pins (192: shared project coordination),
 * NOT the activity log (239: raw complete history). It is private, short, lossy, per-agent working state.
 * The agent is the author (Bridge get/set/status); Tachyon stamps the frontmatter and re-injects a pointer
 * at a genuine discontinuity (D3/D9). Soft size cap (D7) — warn, never truncate.
 */

export const CONTINUITY_SOFT_CAP_BYTES = 8 * 1024; // D7 — warn above this, never truncate

export type ContinuityStatus = "active" | "paused" | "blocked" | "done";

export interface ContinuityMeta {
  version: number;
  agent: string;
  updated_at: string;
  updated_by: "agent" | "tachyon";
  source_session_id?: string;
  /** the activity seq this brief reflects — the freshness anchor (D4) */
  source_activity_seq?: number;
  status: ContinuityStatus;
  /** fork provenance (D8) */
  forked_from_agent?: string;
  forked_from_session_id?: string;
  /** unknown/future fields are preserved verbatim on rewrite (D7) */
  [k: string]: unknown;
}

export interface ContinuityBrief {
  meta: ContinuityMeta;
  /** the markdown body (the sections the agent authored) */
  body: string;
}

export interface WriteOptions {
  updatedBy?: "agent" | "tachyon";
  status?: ContinuityStatus;
  sourceSessionId?: string;
  sourceActivitySeq?: number;
  /** extra frontmatter fields to set/merge (e.g. fork provenance) */
  extraMeta?: Record<string, unknown>;
}

export interface WriteResult {
  path: string;
  bytes: number;
  /** set when the written brief exceeds the soft size cap (D7) — advisory, never blocks the write */
  warning?: string;
}

const VALID_STATUS: ReadonlySet<string> = new Set(["active", "paused", "blocked", "done"]);

export class ContinuityStore {
  constructor(
    private readonly workspaceRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get dir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "continuity");
  }

  pathOf(agent: string): string {
    return path.join(this.dir, `${agent}.md`);
  }

  exists(agent: string): boolean {
    return fs.existsSync(this.pathOf(agent));
  }

  /**
   * Read + parse a brief. Returns null when none exists yet (cold start). Throws on malformed frontmatter
   * (D7 — never silently treat a corrupt/hand-broken file as empty; surface it so the agent/human fixes it).
   */
  read(agent: string): ContinuityBrief | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.pathOf(agent), "utf8");
    } catch {
      return null; // not created yet
    }
    return parseBrief(raw, agent);
  }

  /**
   * Write the brief: the caller supplies the markdown BODY; Tachyon owns + stamps the frontmatter, preserving
   * any existing unknown/fork fields. Atomic (tmp + rename). Returns the byte size + a soft-cap warning (D7).
   */
  write(agent: string, body: string, opts: WriteOptions = {}): WriteResult {
    if (opts.status !== undefined && !VALID_STATUS.has(opts.status)) {
      throw new Error(`invalid continuity status '${opts.status}' (active | paused | blocked | done)`);
    }
    const prev = this.readQuiet(agent);
    const meta: ContinuityMeta = {
      ...(prev?.meta ?? {}), // preserve unknown/fork fields across rewrites (D7/D8)
      version: 1,
      agent,
      updated_at: this.now().toISOString(),
      updated_by: opts.updatedBy ?? "agent",
      status: opts.status ?? prev?.meta.status ?? "active",
    };
    if (opts.sourceSessionId !== undefined) meta.source_session_id = opts.sourceSessionId;
    if (opts.sourceActivitySeq !== undefined) meta.source_activity_seq = opts.sourceActivitySeq;
    if (opts.extraMeta) Object.assign(meta, opts.extraMeta);

    const text = serializeBrief({ meta, body });
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.pathOf(agent);
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`; // unique across processes/windows
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, target); // atomic on the same filesystem
    const bytes = Buffer.byteLength(text, "utf8");
    return {
      path: target,
      bytes,
      warning:
        bytes > CONTINUITY_SOFT_CAP_BYTES
          ? `continuity brief is ${bytes} bytes (> ${CONTINUITY_SOFT_CAP_BYTES} soft cap) — keep it short; trim older detail`
          : undefined,
    };
  }

  /** Remove an agent's brief (explicit delete/dismiss). Best-effort. */
  remove(agent: string): void {
    try {
      fs.rmSync(this.pathOf(agent), { force: true });
    } catch {
      /* best-effort */
    }
  }

  /** read() but malformed frontmatter degrades to null (used internally so a write can always recover). */
  private readQuiet(agent: string): ContinuityBrief | null {
    try {
      return this.read(agent);
    } catch {
      return null;
    }
  }
}

/** Parse `---\n<yaml>\n---\n<body>` → brief. Throws on a present-but-malformed brief (D7). */
export function parseBrief(raw: string, agent: string): ContinuityBrief {
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!fm) {
    throw new Error(`.tachyon/continuity/${agent}.md is malformed — missing YAML frontmatter (--- … ---)`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(fm[1]);
  } catch {
    throw new Error(`.tachyon/continuity/${agent}.md has invalid YAML frontmatter — fix or delete it`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`.tachyon/continuity/${agent}.md frontmatter must be a mapping`);
  }
  const meta = parsed as Record<string, unknown>;
  const status = typeof meta.status === "string" && VALID_STATUS.has(meta.status) ? (meta.status as ContinuityStatus) : "active";
  return {
    meta: {
      ...meta,
      version: typeof meta.version === "number" ? meta.version : 1,
      agent: typeof meta.agent === "string" ? meta.agent : agent,
      updated_at: typeof meta.updated_at === "string" ? meta.updated_at : "",
      updated_by: meta.updated_by === "tachyon" ? "tachyon" : "agent",
      status,
    },
    body: (fm[2] ?? "").trim(),
  };
}

/** brief → `---\n<yaml>\n---\n\n<body>\n`. */
export function serializeBrief(brief: ContinuityBrief): string {
  const yaml = stringifyYaml(brief.meta).trimEnd();
  const body = brief.body.trim();
  return `---\n${yaml}\n---\n\n${body}${body.endsWith("\n") || body === "" ? "" : "\n"}`;
}

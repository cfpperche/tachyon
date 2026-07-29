import type { ProjectHandoffStore, StalenessState } from "../handoff/ProjectHandoffStore.js";
import {
  listHandoffDistillTargets,
  type HandoffDistillOperations,
} from "../handoff/handoffDistillService.js";
import { isSafeHandoffRelativePath, projectHandoffRelativePath } from "../handoff/handoffPath.js";
import type { HandoffDistillTargetState } from "../handoff/distill.js";
import type { AgentInstanceLifetime, AgentInstanceResumePolicy } from "../resume/SessionLedger.js";

export const HANDOFF_BODY_MAX_CHARS = 1024 * 1024;
export const HANDOFF_PENDING_NOTE_LIMIT = 1_000;
export const HANDOFF_TARGET_LIMIT = 1_000;

export interface HandoffNoteProjectionV1 {
  ts: string;
  agent: string;
  kind: "completed" | "blocked" | "decision" | "gotcha" | "next";
  summary: string;
  evidence: string[];
}

export interface HandoffDistillTargetProjectionV1 {
  name: string;
  description: string;
  state: HandoffDistillTargetState;
  /**
   * t-04052d — replaces `declared`. The wire states the durability of the DEFINITION rather than which
   * store happened to hold it.
   */
  lifetime: AgentInstanceLifetime;
  /**
   * The second axis travels too, because the eligibility rule below needs BOTH and a validator that
   * cannot restate the rule is not validating it.
   */
  resumePolicy: AgentInstanceResumePolicy;
}

export interface HandoffProjectionV1 {
  canonicalRelativePath: string;
  exists: boolean;
  body: string;
  staleness: StalenessState;
  pendingCount: number;
  updatedAt: string;
  updatedBy: "human" | "agent" | "tachyon" | "";
  revision: string;
  notes: HandoffNoteProjectionV1[];
  distillTargets: HandoffDistillTargetProjectionV1[];
}

export interface HandoffViewV1 {
  schemaVersion: 1;
  handoff: HandoffProjectionV1;
}

export async function projectHandoffView(input: {
  workspaceRoot: string;
  store: ProjectHandoffStore;
  lastActivityAt: string | null;
  distill: Pick<HandoffDistillOperations, "listAgents" | "resumableAgentNames">;
}): Promise<HandoffViewV1> {
  const canonicalRelativePath = projectHandoffRelativePath(input.workspaceRoot, input.store.canonicalPath);
  const snapshot = input.store.snapshot(input.lastActivityAt);
  if (snapshot.pending.length > HANDOFF_PENDING_NOTE_LIMIT) {
    throw new Error(`project handoff exceeds its ${HANDOFF_PENDING_NOTE_LIMIT}-note presentation limit`);
  }
  const targets = await listHandoffDistillTargets(input.distill);
  if (targets.length > HANDOFF_TARGET_LIMIT) {
    throw new Error(`project handoff exceeds its ${HANDOFF_TARGET_LIMIT}-target presentation limit`);
  }
  return parseHandoffViewV1({
    schemaVersion: 1,
    handoff: {
      canonicalRelativePath,
      exists: snapshot.exists,
      body: snapshot.body,
      staleness: snapshot.staleness,
      pendingCount: snapshot.pendingCount,
      updatedAt: snapshot.meta?.updated_at ?? "",
      updatedBy: snapshot.meta?.updated_by ?? "",
      revision: snapshot.revision,
      notes: snapshot.pending.map((note) => ({ ...note, evidence: [...note.evidence] })),
      distillTargets: targets.map((target) => ({ ...target })),
    },
  });
}

export function isHandoffViewV1(value: unknown): value is HandoffViewV1 {
  try {
    parseHandoffViewV1(value);
    return true;
  } catch {
    return false;
  }
}

export function parseHandoffViewV1(value: unknown): HandoffViewV1 {
  const root = exactRecord(value, ["schemaVersion", "handoff"], "handoff view");
  if (root.schemaVersion !== 1) throw invalid("handoff view schemaVersion is invalid");
  const input = exactRecord(root.handoff, [
    "canonicalRelativePath", "exists", "body", "staleness", "pendingCount", "updatedAt", "updatedBy",
    "revision", "notes", "distillTargets",
  ], "handoff projection");
  if (!isSafeHandoffRelativePath(input.canonicalRelativePath)) throw invalid("handoff relative path is invalid");
  if (typeof input.exists !== "boolean") throw invalid("handoff exists is invalid");
  const body = boundedString(input.body, 0, HANDOFF_BODY_MAX_CHARS, "handoff body");
  if (input.staleness !== "fresh" && input.staleness !== "needs_distill"
    && input.staleness !== "possibly_stale" && input.staleness !== "old") {
    throw invalid("handoff staleness is invalid");
  }
  const updatedAt = boundedString(input.updatedAt, 0, 64, "handoff updatedAt");
  if (updatedAt && !isCanonicalTimestamp(updatedAt)) throw invalid("handoff updatedAt is invalid");
  if (input.updatedBy !== "" && input.updatedBy !== "human" && input.updatedBy !== "agent" && input.updatedBy !== "tachyon") {
    throw invalid("handoff updatedBy is invalid");
  }
  const revision = boundedString(input.revision, 0, 16, "handoff revision");
  if (revision && !/^[a-f0-9]{16}$/.test(revision)) throw invalid("handoff revision is invalid");
  if (!Array.isArray(input.notes) || input.notes.length > HANDOFF_PENDING_NOTE_LIMIT) {
    throw invalid("handoff notes exceed their limit");
  }
  // t-7b1f87 — ONE unparseable note (e.g. a pre-canonical-timestamp legacy record) must not blank the
  // entire handoff: projectNote() is tolerant per-note, dropping only that one rather than throwing.
  // pendingCount is DERIVED from the (possibly filtered) `notes` actually returned, not blindly trusted
  // off `input.pendingCount` — this function round-trips through itself (engineService.ts builds a wire
  // response from its own return value, then the client re-validates that SAME payload via
  // isHandoffViewV1/parseHandoffViewV1 again), so pendingCount must equal notes.length on EVERY pass,
  // including a second pass over an already-filtered array, not just the first. `input.pendingCount` is
  // still shape-validated (a corrupt/out-of-range field is still a genuine "reject the whole message"
  // case) even though its value isn't the one returned.
  const notes = input.notes.map(projectNote).filter((n): n is HandoffNoteProjectionV1 => n !== undefined);
  safeInteger(input.pendingCount, 0, HANDOFF_PENDING_NOTE_LIMIT, "handoff pendingCount");
  const pendingCount = notes.length;
  if (!Array.isArray(input.distillTargets) || input.distillTargets.length > HANDOFF_TARGET_LIMIT) {
    throw invalid("handoff targets exceed their limit");
  }
  const distillTargets = input.distillTargets.map(projectTarget);
  if (new Set(distillTargets.map((target) => target.name)).size !== distillTargets.length) {
    throw invalid("handoff targets contain duplicate names");
  }
  if (!input.exists && (body !== "" || updatedAt !== "" || input.updatedBy !== "" || revision !== "")) {
    throw invalid("missing handoff contradicts canonical metadata");
  }
  if (input.exists && (!updatedAt || !input.updatedBy || !revision)) {
    throw invalid("existing handoff is missing canonical metadata");
  }
  return {
    schemaVersion: 1,
    handoff: {
      canonicalRelativePath: input.canonicalRelativePath,
      exists: input.exists,
      body,
      staleness: input.staleness,
      pendingCount,
      updatedAt,
      updatedBy: input.updatedBy,
      revision,
      notes,
      distillTargets,
    },
  };
}

/** t-7b1f87 — returns undefined (never throws) for a note this build cannot make sense of, so ONE bad
 *  record degrades to "one fewer note shown", not "the whole handoff fails to load". */
function projectNote(value: unknown): HandoffNoteProjectionV1 | undefined {
  try {
    const input = exactRecord(value, ["ts", "agent", "kind", "summary", "evidence"], "handoff note");
    const ts = canonicalizeHandoffTimestamp(input.ts);
    if (input.kind !== "completed" && input.kind !== "blocked" && input.kind !== "decision"
      && input.kind !== "gotcha" && input.kind !== "next") throw invalid("handoff note kind is invalid");
    if (!Array.isArray(input.evidence) || input.evidence.length > 20) throw invalid("handoff note evidence exceeds its limit");
    return {
      ts,
      agent: boundedString(input.agent, 1, 128, "handoff note agent"),
      kind: input.kind,
      summary: boundedString(input.summary, 1, 2_000, "handoff note summary"),
      evidence: input.evidence.map((item) => boundedString(item, 0, 400, "handoff note evidence")),
    };
  } catch {
    return undefined;
  }
}

/** t-7b1f87 — the canonical 24-char ISO form (Date#toISOString's exact shape), but tolerant of a
 *  near-miss on the way in (e.g. a legacy writer that omitted milliseconds) by round-tripping through
 *  Date rather than requiring the input to already be exactly canonical. */
function canonicalizeHandoffTimestamp(value: unknown): string {
  const raw = boundedString(value, 16, 40, "handoff note timestamp");
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw invalid("handoff note timestamp is invalid");
  return date.toISOString();
}

function projectTarget(value: unknown): HandoffDistillTargetProjectionV1 {
  const input = exactRecord(value, ["name", "description", "state", "lifetime", "resumePolicy"], "handoff target");
  if (input.state !== "running" && input.state !== "resumable" && input.state !== "stopped") {
    throw invalid("handoff target state is invalid");
  }
  if (input.lifetime !== "saved" && input.lifetime !== "temporary") throw invalid("handoff target lifetime is invalid");
  if (input.resumePolicy !== "restartable" && input.resumePolicy !== "collected") throw invalid("handoff target resumePolicy is invalid");
  // t-04052d — THE REFUSAL SURVIVES THE FIELD IT USED TO LIVE ON, and needs BOTH axes to be stated
  // correctly. It was `!declared && state !== "running"`, and it is a rule rather than a label: hand
  // work off only to an agent whose definition is still there to receive it.
  //
  // A plain Temporary's definition dies with its session, so once it stops there is nothing left. A
  // FORK is Temporary too but `restartable` — it owns its resume block, and its definition reloads.
  // Written on `lifetime` alone this refused the fork, which is `lifetime` silently absorbing resume
  // capability: the exact collapse the two axes exist to prevent.
  if (input.lifetime === "temporary" && input.state !== "running" && input.resumePolicy !== "restartable") {
    throw invalid("stopped temporary agent cannot be a handoff target");
  }
  const name = boundedString(input.name, 1, 128, "handoff target name");
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name)) throw invalid("handoff target name is invalid");
  const expectedDescription = `${input.state} · ${input.lifetime}`;
  if (input.description !== expectedDescription) throw invalid("handoff target description contradicts its state");
  return { name, description: expectedDescription, state: input.state, lifetime: input.lifetime, resumePolicy: input.resumePolicy };
}

function isCanonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function exactRecord(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`);
  const input = value as Record<string, unknown>;
  const actual = Object.keys(input);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw invalid(`${label} has unknown or missing fields`);
  }
  return input;
}

function boundedString(value: unknown, min: number, max: number, label: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max) throw invalid(`${label} is invalid`);
  return value;
}

function safeInteger(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid(`${label} is invalid`);
  return value as number;
}

function invalid(message: string): Error {
  return new Error(message);
}

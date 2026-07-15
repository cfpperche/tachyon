import type { ProjectHandoffStore, StalenessState } from "../handoff/ProjectHandoffStore.js";
import {
  listHandoffDistillTargets,
  type HandoffDistillOperations,
} from "../handoff/handoffDistillService.js";
import { isSafeHandoffRelativePath, projectHandoffRelativePath } from "../handoff/handoffPath.js";
import type { HandoffDistillTargetState } from "../handoff/distill.js";

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
  declared: boolean;
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
  const notes = input.notes.map(projectNote);
  const pendingCount = safeInteger(input.pendingCount, 0, HANDOFF_PENDING_NOTE_LIMIT, "handoff pendingCount");
  if (pendingCount !== notes.length) throw invalid("handoff pendingCount contradicts its notes");
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

function projectNote(value: unknown): HandoffNoteProjectionV1 {
  const input = exactRecord(value, ["ts", "agent", "kind", "summary", "evidence"], "handoff note");
  const ts = boundedString(input.ts, 24, 24, "handoff note timestamp");
  if (!isCanonicalTimestamp(ts)) throw invalid("handoff note timestamp is invalid");
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
}

function projectTarget(value: unknown): HandoffDistillTargetProjectionV1 {
  const input = exactRecord(value, ["name", "description", "state", "declared"], "handoff target");
  if (input.state !== "running" && input.state !== "resumable" && input.state !== "stopped") {
    throw invalid("handoff target state is invalid");
  }
  if (typeof input.declared !== "boolean") throw invalid("handoff target declared is invalid");
  if (!input.declared && input.state !== "running") throw invalid("stopped ad-hoc agent cannot be a handoff target");
  const name = boundedString(input.name, 1, 128, "handoff target name");
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name)) throw invalid("handoff target name is invalid");
  const expectedDescription = `${input.state} · ${input.declared ? "declared" : "ad-hoc"}`;
  if (input.description !== expectedDescription) throw invalid("handoff target description contradicts its state");
  return { name, description: expectedDescription, state: input.state, declared: input.declared };
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

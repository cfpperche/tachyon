import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TASK_PRIORITIES, type ArtifactRef, type TaskPriority } from "../tasks/types.js";
import {
  isValidationExecutor,
  isValidationOutcome,
  isValidationStatus,
  VALIDATION_ID_RE,
  type Validation,
  type ValidationCloseInput,
  type ValidationCreateInput,
  type ValidationRound,
  type ValidationUpdateExpect,
  type ValidationUpdateInput,
} from "./types.js";

const VALIDATION_STATUS_TRANSITIONS: Record<Validation["status"], Validation["status"][]> = {
  pending: ["triaged", "closed"],
  triaged: ["running", "pending", "closed"],
  running: ["triaged", "closed"],
  closed: ["triaged"],
};

export function allowedValidationTransitions(status: Validation["status"]): Validation["status"][] {
  return VALIDATION_STATUS_TRANSITIONS[status];
}

export class ValidationStore {
  private mutation: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {}

  get dir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "validations");
  }

  async create(input: ValidationCreateInput): Promise<Validation> {
    return this.withMutation(async () => {
      const now = input.now ?? new Date().toISOString();
      const validation: Omit<Validation, "id"> = {
        title: boundedString(input.title, "title", 300),
        status: input.assignee ? "triaged" : "pending",
        executor: input.executor ?? "either",
        rounds: [],
        author: boundedString(input.author || "human", "author", 64),
        createdAt: now,
        updatedAt: now,
        ...optionalStringField("type", input.type, 64),
        ...optionalPriority(input.priority),
        ...optionalStringField("assignee", input.assignee, 64),
        ...optionalStringField("instructions", input.instructions, 4000),
        ...optionalArtifactRefs("source_refs", input.source_refs, 20),
      };
      if (!isValidationExecutor(validation.executor)) throw new Error(`invalid validation executor '${String(validation.executor)}'`);
      fs.mkdirSync(this.dir, { recursive: true });
      for (let i = 0; i < 20; i++) {
        try {
          return this.writeNewValidation(mintValidationId(), validation);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw err;
        }
      }
      throw new Error("could not mint a unique validation id");
    });
  }

  get(id: string): Validation {
    assertValidationId(id);
    const v = normalizeValidation(readJson(this.pathFor(id)), id);
    if (!v) throw new Error(`validation '${id}' not found`);
    return v;
  }

  list(limit = 500): Validation[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: Validation[] = [];
    for (const name of fs.readdirSync(this.dir).sort()) {
      if (!name.endsWith(".json") || name.includes(".tmp.")) continue;
      const id = name.slice(0, -".json".length);
      if (!VALIDATION_ID_RE.test(id)) continue;
      const row = normalizeValidation(readJson(path.join(this.dir, name)), id);
      if (row) out.push(row);
      if (out.length >= limit) break;
    }
    return out;
  }

  async update(id: string, input: ValidationUpdateInput): Promise<Validation> {
    assertValidationId(id);
    return this.withMutation(async () => {
      const current = this.get(id);
      assertExpect(current, input.expect);
      const next = applyUpdate(current, input);
      assertTransition(current, next);
      if (JSON.stringify(stripRuntime(input)) === "{}") throw new Error("update_validation requires at least one field");
      if (JSON.stringify(current) === JSON.stringify(next)) throw new Error("update_validation requires at least one changed field");
      this.writeExistingValidation(next);
      return next;
    });
  }

  async closeRound(id: string, input: ValidationCloseInput): Promise<Validation> {
    assertValidationId(id);
    return this.withMutation(async () => {
      const current = this.get(id);
      assertExpect(current, input.expect);
      if (current.status === "closed") throw new Error("validation is already closed; reopen it before recording another round");
      if (!isValidationOutcome(input.outcome)) throw new Error(`invalid validation outcome '${String(input.outcome)}'`);
      const evidence = input.evidence_refs ? normalizeArtifactRefs("evidence_refs", input.evidence_refs, 20) : [];
      const note = input.result_note?.trim();
      if (evidence.length === 0 && !note) throw new Error("closing a validation round requires evidence_refs or result_note");
      const now = input.now ?? new Date().toISOString();
      const round: ValidationRound = {
        n: current.rounds.length + 1,
        startedAt: current.status === "running" ? current.updatedAt : now,
        closedAt: now,
        ...(input.assignee ?? current.assignee ? { assignee: boundedString(input.assignee ?? current.assignee ?? "", "assignee", 64) } : {}),
        outcome: input.outcome,
        ...(evidence.length ? { evidence_refs: evidence } : {}),
        ...(note ? { result_note: boundedString(note, "result_note", 4000) } : {}),
      };
      const next: Validation = { ...current, status: "closed", rounds: [...current.rounds, round], updatedAt: now };
      this.writeExistingValidation(next);
      return next;
    });
  }

  private writeNewValidation(id: string, validation: Omit<Validation, "id">): Validation {
    const finalPath = this.pathFor(id);
    const tmp = `${finalPath}.tmp.${process.pid}.${crypto.randomBytes(3).toString("hex")}`;
    fs.writeFileSync(tmp, `${JSON.stringify({ id, ...validation }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.linkSync(tmp, finalPath);
    fs.rmSync(tmp, { force: true });
    return { id, ...validation };
  }

  private writeExistingValidation(validation: Validation): void {
    const finalPath = this.pathFor(validation.id);
    const tmp = `${finalPath}.tmp.${process.pid}.${crypto.randomBytes(3).toString("hex")}`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(validation, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, finalPath);
  }

  private pathFor(id: string): string {
    assertValidationId(id);
    return path.join(this.dir, `${id}.json`);
  }

  private async withMutation<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export type ValidationSummary = Omit<Validation, "instructions"> & { currentRound?: ValidationRound };

export function validationSummary(v: Validation): ValidationSummary {
  const { instructions: _instructions, ...summary } = v;
  const currentRound = v.rounds.at(-1);
  return { ...summary, ...(currentRound ? { currentRound } : {}) };
}

export function mintValidationId(): string {
  return `v-${crypto.randomBytes(3).toString("hex")}`;
}

function assertValidationId(id: string): void {
  if (!VALIDATION_ID_RE.test(id)) throw new Error(`invalid validation id '${id}'`);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function normalizeValidation(input: unknown, expectedId: string): Validation | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Partial<Validation>;
  if (row.id !== expectedId || typeof row.title !== "string" || !isValidationStatus(row.status) || !isValidationExecutor(row.executor) || typeof row.author !== "string" || typeof row.createdAt !== "string" || typeof row.updatedAt !== "string") return null;
  if (row.priority !== undefined && !isPriority(row.priority)) return null;
  const rounds = normalizeRounds(row.rounds);
  if (!rounds) return null;
  return {
    id: row.id,
    title: boundedString(row.title, "title", 300),
    ...(typeof row.type === "string" ? optionalStringField("type", row.type, 64) : {}),
    status: row.status,
    executor: row.executor,
    ...(row.priority !== undefined ? { priority: row.priority } : {}),
    ...(typeof row.assignee === "string" ? optionalStringField("assignee", row.assignee, 64) : {}),
    ...(typeof row.instructions === "string" ? optionalStringField("instructions", row.instructions, 4000) : {}),
    ...optionalArtifactRefs("source_refs", row.source_refs, 20),
    rounds,
    author: boundedString(row.author, "author", 64),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeRounds(input: unknown): ValidationRound[] | null {
  if (!Array.isArray(input)) return null;
  const out: ValidationRound[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Partial<ValidationRound>;
    if (!Number.isInteger(row.n) || row.n !== out.length + 1) return null;
    if (row.outcome !== undefined && !isValidationOutcome(row.outcome)) return null;
    const evidence = row.evidence_refs ? normalizeArtifactRefs("evidence_refs", row.evidence_refs, 20) : [];
    out.push({
      n: row.n,
      ...(typeof row.startedAt === "string" ? { startedAt: row.startedAt } : {}),
      ...(typeof row.closedAt === "string" ? { closedAt: row.closedAt } : {}),
      ...(typeof row.assignee === "string" ? optionalStringField("assignee", row.assignee, 64) : {}),
      ...(row.outcome ? { outcome: row.outcome } : {}),
      ...(evidence.length ? { evidence_refs: evidence } : {}),
      ...(typeof row.result_note === "string" ? optionalStringField("result_note", row.result_note, 4000) : {}),
    });
  }
  return out;
}

function applyUpdate(current: Validation, input: ValidationUpdateInput): Validation {
  const now = input.now ?? new Date().toISOString();
  const next: Validation = { ...current, updatedAt: now };
  if (input.title !== undefined) next.title = boundedString(input.title, "title", 300);
  applyOptionalStringPatch(next, "type", input.type, 64);
  if (input.status !== undefined) {
    if (!isValidationStatus(input.status)) throw new Error(`invalid validation status '${String(input.status)}'`);
    next.status = input.status;
  }
  if (input.executor !== undefined) {
    if (!isValidationExecutor(input.executor)) throw new Error(`invalid validation executor '${String(input.executor)}'`);
    next.executor = input.executor;
  }
  if (input.priority !== undefined) {
    if (input.priority === null) delete next.priority;
    else {
      if (!isPriority(input.priority)) throw new Error("priority must be an integer 0..3");
      next.priority = input.priority;
    }
  }
  applyOptionalStringPatch(next, "assignee", input.assignee, 64);
  applyOptionalStringPatch(next, "instructions", input.instructions, 4000);
  if (input.source_refs !== undefined) {
    if (input.source_refs === null) delete next.source_refs;
    else {
      const refs = normalizeArtifactRefs("source_refs", input.source_refs, 20);
      if (refs.length) next.source_refs = refs;
      else delete next.source_refs;
    }
  }
  if (next.status === "pending") delete next.assignee;
  return next;
}

function assertExpect(validation: Validation, expect?: ValidationUpdateExpect): void {
  if (!expect) return;
  if (expect.status !== undefined && validation.status !== expect.status) throw new Error("precondition-failed: status did not match");
  if ("assignee" in expect && (validation.assignee ?? null) !== (expect.assignee ?? null)) throw new Error("precondition-failed: assignee did not match");
  if (expect.updatedAt !== undefined && validation.updatedAt !== expect.updatedAt) throw new Error("precondition-failed: updatedAt did not match");
}

function assertTransition(current: Validation, next: Validation): void {
  if (current.status === next.status) return;
  if (!allowedValidationTransitions(current.status).includes(next.status)) throw new Error(`invalid validation status transition ${current.status} -> ${next.status}`);
  if (next.status === "running" && !next.assignee) throw new Error("running validations require assignee");
}

function stripRuntime(input: ValidationUpdateInput): Partial<ValidationUpdateInput> {
  const { now: _now, expect: _expect, ...rest } = input;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as Partial<ValidationUpdateInput>;
}

function boundedString(value: string, name: string, max: number): string {
  const out = value.trim();
  if (!out) throw new Error(`${name} must be non-empty`);
  if ([...out].length > max) throw new Error(`${name} must be at most ${max} code points`);
  return out;
}

function optionalStringField<K extends "title" | "type" | "assignee" | "instructions" | "author" | "result_note">(key: K, value: string | undefined, max: number): Record<K, string> | {} {
  if (value === undefined) return {};
  return { [key]: boundedString(value, key, max) } as Record<K, string>;
}

function applyOptionalStringPatch<K extends "type" | "assignee" | "instructions">(validation: Validation, key: K, value: string | null | undefined, max: number): void {
  if (value === undefined) return;
  if (value === null) delete validation[key];
  else Object.assign(validation, optionalStringField(key, value, max));
}

function optionalPriority(priority: TaskPriority | undefined): Pick<Validation, "priority"> | {} {
  if (priority === undefined) return {};
  if (!isPriority(priority)) throw new Error("priority must be an integer 0..3");
  return { priority };
}

function isPriority(value: unknown): value is TaskPriority {
  return Number.isInteger(value) && (TASK_PRIORITIES as readonly number[]).includes(value as number);
}

function optionalArtifactRefs<K extends "source_refs" | "evidence_refs">(key: K, refs: ArtifactRef[] | undefined, max: number): Record<K, ArtifactRef[]> | {} {
  if (refs === undefined) return {};
  const out = normalizeArtifactRefs(key, refs, max);
  return out.length ? { [key]: out } as Record<K, ArtifactRef[]> : {};
}

function normalizeArtifactRefs(name: string, refs: ArtifactRef[], max: number): ArtifactRef[] {
  if (!Array.isArray(refs)) throw new Error(`${name} must be an array`);
  if (refs.length > max) throw new Error(`${name} may contain at most ${max} entries`);
  const out: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") throw new Error(`${name} entries must be objects`);
    const type = boundedString(String((ref as ArtifactRef).type ?? ""), `${name}.type`, 64);
    const value = boundedString(String((ref as ArtifactRef).ref ?? ""), `${name}.ref`, 500);
    const key = `${type}\0${value}`;
    if (seen.has(key)) throw new Error(`duplicate ${name} '${type}:${value}'`);
    seen.add(key);
    out.push({ type, ref: value });
  }
  return out;
}

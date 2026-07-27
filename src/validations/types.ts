import type { ArtifactRef, TaskPriority } from "../tasks/types.js";

export const VALIDATION_STATUSES = ["pending", "triaged", "running", "closed"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export const VALIDATION_EXECUTORS = ["human", "agent", "either"] as const;
export type ValidationExecutor = (typeof VALIDATION_EXECUTORS)[number];

export const VALIDATION_OUTCOMES = ["passed", "failed", "skipped"] as const;
export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number];

/** The Bridge's own caller kinds — a validation actor is never self-declared, so this mirrors them. */
export const VALIDATION_ACTOR_KINDS = ["agent", "human", "master", "legacy", "external"] as const;
export type ValidationActorKind = (typeof VALIDATION_ACTOR_KINDS)[number];

/**
 * t-98256c — who acted on a validation. For a Bridge call this is the resolved caller (the same
 * identity `request_human_approval` refuses to take as a parameter); for a close from the editor the
 * host stamps its own surface, exactly as an approval records `resolvedBy`. It is an argument rather
 * than a tool field precisely so a caller cannot claim to be someone else.
 */
export interface ValidationActor {
  kind: ValidationActorKind;
  /** the resolved agent name for kind "agent"; the host surface (e.g. "vscode") for a human close. */
  name?: string;
}

/**
 * The stamp the HOST applies when the human closes or reassigns from the editor. It is a constant on
 * this side of the wire on purpose: a webview cannot send an actor, so it cannot claim to be a human.
 */
export const EDITOR_HUMAN_ACTOR: ValidationActor = { kind: "human", name: "vscode" };

export interface ValidationRound {
  n: number;
  startedAt?: string;
  closedAt?: string;
  assignee?: string;
  outcome?: ValidationOutcome;
  evidence_refs?: ArtifactRef[];
  result_note?: string;
  /** Provenance of the closure — absent on rounds recorded before t-98256c. */
  closedBy?: ValidationActor;
}

export interface Validation {
  id: string;
  title: string;
  type?: string;
  status: ValidationStatus;
  executor: ValidationExecutor;
  priority?: TaskPriority;
  assignee?: string;
  instructions?: string;
  source_refs?: ArtifactRef[];
  rounds: ValidationRound[];
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationCreateInput {
  title: string;
  author: string;
  type?: string;
  executor?: ValidationExecutor;
  priority?: TaskPriority;
  assignee?: string;
  instructions?: string;
  source_refs?: ArtifactRef[];
  now?: string;
}

export interface ValidationUpdateExpect {
  status?: ValidationStatus;
  assignee?: string | null;
  updatedAt?: string;
}

export interface ValidationUpdateInput {
  title?: string;
  type?: string | null;
  status?: ValidationStatus;
  executor?: ValidationExecutor;
  priority?: TaskPriority | null;
  assignee?: string | null;
  instructions?: string | null;
  source_refs?: ArtifactRef[] | null;
  expect?: ValidationUpdateExpect;
  now?: string;
  /** Who is patching. Required for the same reason as on close (t-98256c). */
  actor: ValidationActor;
}

export interface ValidationCloseInput {
  /** Who is closing. Required so no path can close without saying who acted (t-98256c). */
  actor: ValidationActor;
  outcome: ValidationOutcome;
  result_note?: string;
  evidence_refs?: ArtifactRef[];
  assignee?: string;
  expect?: ValidationUpdateExpect;
  now?: string;
}

export type NextValidationResult =
  | { validation: Validation }
  | { empty: true; reason: "no-validations" | "all-human-only" | "all-assigned-elsewhere" };

export interface ValidationCandidate {
  title: string;
  type?: string;
  executor: ValidationExecutor;
  source_ref: ArtifactRef;
  excerpt: string;
}

export const VALIDATION_ID_RE = /^v-[0-9a-f]{6}$/;

export function isValidationStatus(value: unknown): value is ValidationStatus {
  return typeof value === "string" && (VALIDATION_STATUSES as readonly string[]).includes(value);
}

export function isValidationExecutor(value: unknown): value is ValidationExecutor {
  return typeof value === "string" && (VALIDATION_EXECUTORS as readonly string[]).includes(value);
}

export function isValidationOutcome(value: unknown): value is ValidationOutcome {
  return typeof value === "string" && (VALIDATION_OUTCOMES as readonly string[]).includes(value);
}

export function isValidationActorKind(value: unknown): value is ValidationActorKind {
  return typeof value === "string" && (VALIDATION_ACTOR_KINDS as readonly string[]).includes(value);
}

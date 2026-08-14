import type { ArtifactRef, TaskPriority } from "@tachyon/shared/tasks/types.js";

export const VALIDATION_STATUSES = ["pending", "triaged", "running", "closed"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export const VALIDATION_EXECUTORS = ["human", "agent", "either"] as const;
export type ValidationExecutor = (typeof VALIDATION_EXECUTORS)[number];

export const VALIDATION_OUTCOMES = ["passed", "failed", "skipped"] as const;
export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number];

/** Bridge-resolved caller kinds, plus an explicit kind for a door that proves only its channel. */
export const VALIDATION_ACTOR_KINDS = ["agent", "human", "master", "legacy", "external", "unattributed"] as const;
export type ValidationActorKind = (typeof VALIDATION_ACTOR_KINDS)[number];

/**
 * t-98256c / t-ebde5f — provenance for an action on a validation. For a Bridge call this is the
 * resolved caller (the same identity `request_human_approval` refuses to take as a parameter). The
 * engine control socket proves no actor: its hello is self-asserted and its nonce is available to
 * every same-uid process, so that door records `kind: "unattributed"` plus a host-owned channel name.
 * This differs deliberately from approvals' string `resolvedBy`: the structured kind carries the
 * "unattributed" warning here instead of encoding it as a value prefix.
 */
export interface ValidationActor {
  kind: ValidationActorKind;
  /** Resolved principal name when known; host-owned channel name when kind is "unattributed". */
  name?: string;
}

/**
 * The stamp the HOST applies when the human closes or reassigns from the editor. It is a constant on
 * this side of the wire on purpose: a webview cannot send an actor, so it cannot claim to be a human.
 */
export const EDITOR_HUMAN_ACTOR: ValidationActor = { kind: "human", name: "vscode" };

/** The daemon's validation command proves this channel, but no human or other actor behind it. */
export const ENGINE_CONTROL_VALIDATION_ACTOR: ValidationActor = {
  kind: "unattributed",
  name: "engine-control",
};

export interface ValidationRound {
  n: number;
  startedAt?: string;
  closedAt?: string;
  assignee?: string;
  outcome?: ValidationOutcome;
  evidence_refs?: ArtifactRef[];
  result_note?: string;
  /** Closure provenance — absent on rounds recorded before t-98256c; may name only a channel. */
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
  /** Resolved actor or explicitly unattributed channel; never infer an actor from the entry point. */
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

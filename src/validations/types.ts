import type { ArtifactRef, TaskPriority } from "../tasks/types.js";

export const VALIDATION_STATUSES = ["pending", "triaged", "running", "closed"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export const VALIDATION_EXECUTORS = ["human", "agent", "either"] as const;
export type ValidationExecutor = (typeof VALIDATION_EXECUTORS)[number];

export const VALIDATION_OUTCOMES = ["passed", "failed", "skipped"] as const;
export type ValidationOutcome = (typeof VALIDATION_OUTCOMES)[number];

export interface ValidationRound {
  n: number;
  startedAt?: string;
  closedAt?: string;
  assignee?: string;
  outcome?: ValidationOutcome;
  evidence_refs?: ArtifactRef[];
  result_note?: string;
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
}

export interface ValidationCloseInput {
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

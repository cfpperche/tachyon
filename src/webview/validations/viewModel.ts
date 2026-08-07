import type { ArtifactRef } from "../../tasks/types.js";
import type { Validation, ValidationActor, ValidationExecutor, ValidationOutcome, ValidationStatus } from "../../validations/types.js";

export interface ValidationRoundVM {
  n: number;
  startedAt?: string;
  closedAt?: string;
  assignee?: string;
  outcome?: ValidationOutcome;
  resultNote?: string;
  closedBy?: ValidationActor;
  evidenceRefs: ArtifactRef[];
}

export interface ValidationViewItem {
  id: string;
  title: string;
  type?: string;
  status: ValidationStatus;
  executor: ValidationExecutor;
  priority?: number;
  assignee?: string;
  instructions?: string;
  sourceRefs: ArtifactRef[];
  rounds: ValidationRoundVM[];
  createdAt: string;
  updatedAt: string;
}

export interface ValidationsViewModel {
  folder: string;
  wsHash: string;
  validations: ValidationViewItem[];
  types: string[];
}

export function buildValidationsViewModel(input: { folder: string; wsHash: string; validations: Validation[] }): ValidationsViewModel {
  const validations = input.validations
    .map((validation): ValidationViewItem => ({
      id: validation.id,
      title: validation.title,
      ...(validation.type ? { type: validation.type } : {}),
      status: validation.status,
      executor: validation.executor,
      ...(validation.priority !== undefined ? { priority: validation.priority } : {}),
      ...(validation.assignee ? { assignee: validation.assignee } : {}),
      ...(validation.instructions ? { instructions: validation.instructions } : {}),
      sourceRefs: validation.source_refs ?? [],
      rounds: validation.rounds.map((round) => ({
        n: round.n,
        ...(round.startedAt ? { startedAt: round.startedAt } : {}),
        ...(round.closedAt ? { closedAt: round.closedAt } : {}),
        ...(round.assignee ? { assignee: round.assignee } : {}),
        ...(round.outcome ? { outcome: round.outcome } : {}),
        ...(round.result_note ? { resultNote: round.result_note } : {}),
        ...(round.closedBy ? { closedBy: round.closedBy } : {}),
        evidenceRefs: round.evidence_refs ?? [],
      })),
      createdAt: validation.createdAt,
      updatedAt: validation.updatedAt,
    }))
    .sort((a, b) => (a.status === "closed" ? 1 : 0) - (b.status === "closed" ? 1 : 0)
      || (a.priority ?? 4) - (b.priority ?? 4)
      || b.updatedAt.localeCompare(a.updatedAt));
  return {
    folder: input.folder,
    wsHash: input.wsHash,
    validations,
    types: [...new Set(validations.flatMap((validation) => validation.type ? [validation.type] : []))].sort(),
  };
}

import type { ArtifactRef } from "@tachyon/shared/tasks/types.js";
import type { ValidationActor, ValidationExecutor, ValidationOutcome, ValidationStatus } from "@tachyon/engine/validations/types.js";
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

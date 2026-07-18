import type { ValidationExecutor, ValidationOutcome } from "../../validations/types";
import type { ValidationsViewModel } from "./viewModel";

export const VALIDATIONS = "validations" as const;
export const VALIDATION_ERROR = "validationError" as const;

export type ValidationsHostMessage =
  | { type: typeof VALIDATIONS; vm: ValidationsViewModel }
  | { type: typeof VALIDATION_ERROR; message: string; id?: string };

export type ValidationsAction =
  | { type: "refreshValidations" }
  | { type: "closeValidationItem"; id: string; outcome: ValidationOutcome; note: string }
  | { type: "assignValidation"; id: string; assignee: string; expect: { assignee: string | null; updatedAt: string } };

export const validationsMessage = (vm: ValidationsViewModel): ValidationsHostMessage => ({ type: VALIDATIONS, vm });
export const validationErrorMessage = (message: string, id?: string): ValidationsHostMessage => ({ type: VALIDATION_ERROR, message, ...(id ? { id } : {}) });
export const refreshValidationsAction = (): ValidationsAction => ({ type: "refreshValidations" });
export const closeValidationItemAction = (id: string, outcome: ValidationOutcome, note: string): ValidationsAction => ({ type: "closeValidationItem", id, outcome, note });
export const assignValidationAction = (id: string, assignee: string, expect: { assignee: string | null; updatedAt: string }): ValidationsAction => ({ type: "assignValidation", id, assignee, expect });

export type ValidationExecutorFilter = "all" | ValidationExecutor;

import type { FormState } from "../formLogic.js";

export const RUNBOOK_STUDIO_DOMAIN_MESSAGE_NAMES = [] as const;

export interface RunbookStudioEntity {
  name?: string;
  fields: FormState;
}

export interface RunbookStudioReferenceData {
  commandNames: string[];
}

export type RunbookStudioFields = FormState;
export type RunbookStudioPatch = FormState;

export function blankRunbookFields(): FormState {
  return {
    name: "",
    cmd: "",
    kind: "runbook",
    instructions: "",
    selfEvolution: false,
    watch: "",
    steps: "",
    cwd: "",
    autostart: false,
    restartOnCrash: false,
    attention: false,
    worktree: false,
    branch: "",
    worktreeSetup: "",
    isolate: false,
    schedTiming: "every",
    schedEvery: "1h",
    schedAt: "09:00",
    schedAction: "run",
    schedTarget: "",
    catchUp: false,
  };
}

export function computeRunbookDirty(entity: RunbookStudioEntity | undefined, fields: FormState): boolean {
  const base = entity?.fields ?? blankRunbookFields();
  return JSON.stringify(base) !== JSON.stringify(fields);
}

export function serializeRunbookPatch(fields: FormState, dirty: boolean): FormState | undefined {
  return dirty ? fields : undefined;
}

export function canDiscardRunbookFields(fields: FormState): boolean {
  return JSON.stringify(fields) === JSON.stringify(blankRunbookFields());
}

export function runbookStudioTitleFor(mode: "new" | "edit", entityId: string | undefined, entity: RunbookStudioEntity | undefined): string {
  if (mode === "new") return "New Runbook";
  return `Runbook Studio — ${entity?.name ?? entityId ?? ""}`;
}

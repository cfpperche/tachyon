import type { FormState } from "../formLogic.js";

export const SCHEDULE_STUDIO_DOMAIN_MESSAGE_NAMES = [] as const;

export interface ScheduleStudioEntity {
  name?: string;
  fields: FormState;
}

export interface ScheduleStudioReferenceData {
  commandNames: string[];
  runbookNames: string[];
  agentNames: string[];
}

export type ScheduleStudioFields = FormState;
export type ScheduleStudioPatch = FormState;

export function blankScheduleFields(): FormState {
  return {
    name: "",
    cmd: "",
    kind: "schedule",
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

export function computeScheduleDirty(entity: ScheduleStudioEntity | undefined, fields: FormState): boolean {
  const base = entity?.fields ?? blankScheduleFields();
  return JSON.stringify(base) !== JSON.stringify(fields);
}

export function serializeSchedulePatch(fields: FormState, dirty: boolean): FormState | undefined {
  return dirty ? fields : undefined;
}

export function canDiscardScheduleFields(fields: FormState): boolean {
  return JSON.stringify(fields) === JSON.stringify(blankScheduleFields());
}

export function scheduleStudioTitleFor(mode: "new" | "edit", entityId: string | undefined, entity: ScheduleStudioEntity | undefined): string {
  if (mode === "new") return "New Schedule";
  return `Schedule Studio - ${entity?.name ?? entityId ?? ""}`;
}

import type { FormState } from "../formLogic.js";

export const COMMAND_STUDIO_DOMAIN_MESSAGE_NAMES = ["browse", "cwd"] as const;

export interface CommandStudioEntity {
  name?: string;
  fields: FormState;
}

export interface CommandStudioReferenceData {
  flagMap: Record<string, string[]>;
  defaultCwd: string;
  verifyCandidates: string[];
}

export type CommandStudioFields = FormState;
export type CommandStudioPatch = FormState;

export function blankCommandFields(): FormState {
  return {
    name: "",
    cmd: "",
    kind: "command",
    instructions: "",
    soul: false,
    selfEvolution: false,
    role: "",
    watch: "",
    steps: "",
    cwd: "",
    autostart: false,
    restartOnCrash: false,
    attention: false,
    worktree: false,
    branch: "",
    worktreeSetup: "",
    verify: "",
    isolate: false,
    schedTiming: "every",
    schedEvery: "1h",
    schedAt: "09:00",
    schedAction: "run",
    schedTarget: "",
    catchUp: false,
  };
}

export function computeCommandDirty(entity: CommandStudioEntity | undefined, fields: FormState): boolean {
  const base = entity?.fields ?? blankCommandFields();
  return JSON.stringify(base) !== JSON.stringify(fields);
}

export function serializeCommandPatch(fields: FormState, dirty: boolean): FormState | undefined {
  return dirty ? fields : undefined;
}

export function canDiscardCommandFields(fields: FormState): boolean {
  return JSON.stringify(fields) === JSON.stringify(blankCommandFields());
}

export function commandStudioTitleFor(mode: "new" | "edit", entityId: string | undefined, entity: CommandStudioEntity | undefined): string {
  if (mode === "new") return "New Command";
  return `Command Studio — ${entity?.name ?? entityId ?? ""}`;
}

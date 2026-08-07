import type { FormState } from "../formLogic.js";

export const TERMINAL_STUDIO_DOMAIN_MESSAGE_NAMES = ["browse", "cwd"] as const;

export interface TerminalStudioEntity {
  name?: string;
  fields: FormState;
}

/** t-b54ead — no `verifyCandidates`: a verify gate is agent-only, so a terminal form has no chip to serve. */
export interface TerminalStudioReferenceData {
  flagMap: Record<string, string[]>;
  defaultCwd: string;
}

export type TerminalStudioFields = FormState;
export type TerminalStudioPatch = FormState;

export function blankTerminalFields(): FormState {
  return {
    name: "",
    cmd: "",
    kind: "terminal",
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
    harness: false,
    harnessInherit: "workspace",
    harnessMcp: "",
    harnessRules: "",
    harnessInstructions: "",
    harnessSkills: "",
    harnessHooks: "",
    isolate: false,
    schedTiming: "every",
    schedEvery: "1h",
    schedAt: "09:00",
    schedAction: "run",
    schedTarget: "",
    catchUp: false,
  };
}

export function computeTerminalDirty(entity: TerminalStudioEntity | undefined, fields: FormState): boolean {
  const base = entity?.fields ?? blankTerminalFields();
  return JSON.stringify(base) !== JSON.stringify(fields);
}

export function serializeTerminalPatch(fields: FormState, dirty: boolean): FormState | undefined {
  return dirty ? fields : undefined;
}

export function canDiscardTerminalFields(fields: FormState): boolean {
  return JSON.stringify(fields) === JSON.stringify(blankTerminalFields());
}

export function terminalStudioTitleFor(mode: "new" | "edit", entityId: string | undefined, entity: TerminalStudioEntity | undefined): string {
  if (mode === "new") return "New Terminal";
  return `Terminal Studio — ${entity?.name ?? entityId ?? ""}`;
}

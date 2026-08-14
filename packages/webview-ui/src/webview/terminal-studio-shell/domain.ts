import type { FormState } from "@tachyon/engine/webview/formLogic.js";

export const TERMINAL_STUDIO_DOMAIN_MESSAGE_NAMES = ["browse", "cwd"] as const;

export interface TerminalStudioEntity {
  name?: string;
  fields: FormState;
}

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

import type * as vscode from "vscode";
import type { EntryKind } from "../config/loadConfig.js";
import type { FormState } from "./formLogic.js";
import type { StudioSaveResult } from "./shared/studio/adapter.js";

export interface StudioSubmit {
  state: FormState;
  editingName?: string;
}

export interface StudioDeps {
  extensionUri: vscode.Uri;
  detectClis: () => Promise<string[]>;
  takenNames: () => string[];
  /** Declared commands: names. Drives Runbook step resolution. */
  commandNames: () => string[];
  /** Stack-derived verify candidates plus declared command/runbook names. */
  verifyCandidates: () => string[];
  defaultCwd: string;
  inferKind: (cmd: string) => EntryKind;
  onSubmit: (submit: StudioSubmit) => string[] | undefined | Promise<string[] | undefined>;
}

/** Preserves the legacy synchronous adapter path while allowing a remote target to resolve asynchronously. */
export function mapStudioSubmitResult(
  result: string[] | undefined | Promise<string[] | undefined>,
  errorCode: string,
): StudioSaveResult | Promise<StudioSaveResult> {
  const map = (errors: string[] | undefined): StudioSaveResult => errors && errors.length > 0
    ? { status: "error", error: { code: errorCode, message: errors.join("; "), source: "validation" } }
    : { status: "ok" };
  return result && typeof (result as Promise<string[] | undefined>).then === "function"
    ? Promise.resolve(result).then(map)
    : map(result as string[] | undefined);
}

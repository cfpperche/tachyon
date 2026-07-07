import * as vscode from "vscode";
import type { EntryKind } from "../config/loadConfig.js";
import type { FormState } from "./formLogic.js";

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
  onSubmit: (submit: StudioSubmit) => string[] | undefined;
}

import * as vscode from "vscode";
import type { NotifyLevel } from "../bridge/tools.js";

/** One toast voice for the whole extension (and every Workspace). */
export function notify(message: string, level: NotifyLevel = "info"): void {
  const show =
    level === "error"
      ? vscode.window.showErrorMessage
      : level === "warn"
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;
  void show(`Tachyon: ${message}`);
}

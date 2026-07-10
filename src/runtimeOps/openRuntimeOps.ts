import * as vscode from "vscode";

export const RUNTIME_OPS_CONTAINER_COMMAND = "workbench.view.extension.tachyonRuntimeOps";
export const RUNTIME_OPS_VIEW_FOCUS_COMMAND = "tachyonRuntimeOpsView.focus";

export type CommandExecutor = (command: string, ...args: unknown[]) => Thenable<unknown>;

/** Reveal the contributed panel container, falling back to VS Code's generated view focus command. */
export async function openRuntimeOps(
  execute: CommandExecutor = (command, ...args) => vscode.commands.executeCommand(command, ...args),
): Promise<void> {
  try {
    await execute(RUNTIME_OPS_CONTAINER_COMMAND);
  } catch {
    await execute(RUNTIME_OPS_VIEW_FOCUS_COMMAND);
  }
}

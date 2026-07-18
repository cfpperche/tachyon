import * as vscode from "vscode";

/** Open Control focused on the Runtime Ops section (no bottom-panel contribution). */
export const RUNTIME_OPS_CONTROL_COMMAND = "tachyon.openControlRuntime";

export type CommandExecutor = (command: string, ...args: unknown[]) => Thenable<unknown>;

/** Reveal Runtime Ops inside Control (editor). Bottom-bar panel container removed. */
export async function openRuntimeOps(
  execute: CommandExecutor = (command, ...args) => vscode.commands.executeCommand(command, ...args),
): Promise<void> {
  await execute(RUNTIME_OPS_CONTROL_COMMAND);
}

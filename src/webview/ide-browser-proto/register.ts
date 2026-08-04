import * as vscode from "vscode";
import { openIdeBrowserProtoPanel } from "./panel.js";

export const IDE_BROWSER_PROTO_CONTEXT = "tachyon.ideBrowserProto.enabled";
export const IDE_BROWSER_PROTO_OPEN_CMD = "tachyon.ideBrowserProto.open";

/**
 * Register the Option A IDE browser prototype.
 * Visible and functional only under Extension Development / Test (Dev Host F5).
 * Production (installed VSIX): context stays false; palette entry hidden; command refuses.
 */
export function registerIdeBrowserProto(context: vscode.ExtensionContext): void {
  const enabled =
    context.extensionMode === vscode.ExtensionMode.Development
    || context.extensionMode === vscode.ExtensionMode.Test
    || process.env.TACHYON_IDE_BROWSER_PROTO === "1";

  void vscode.commands.executeCommand("setContext", IDE_BROWSER_PROTO_CONTEXT, enabled);

  context.subscriptions.push(
    vscode.commands.registerCommand(IDE_BROWSER_PROTO_OPEN_CMD, async () => {
      if (!enabled) {
        void vscode.window.showWarningMessage(
          "IDE Browser prototype is Dev Host only (Extension Development). It is not available in the installed VSIX.",
        );
        return;
      }
      try {
        await openIdeBrowserProtoPanel(context);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`IDE Browser prototype: ${msg}`);
      }
    }),
  );
}

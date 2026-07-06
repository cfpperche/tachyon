import * as vscode from "vscode";

export interface TrustedPanelState {
  schemaVersion: 1;
  view: string;
}

export function registerTrustedPanelSerializer<TState extends TrustedPanelState>(
  context: vscode.ExtensionContext,
  viewType: string,
  revive: (panel: vscode.WebviewPanel, state: TState) => void | Promise<void>,
): void {
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(viewType, {
      async deserializeWebviewPanel(panel, rawState) {
        if (!isTrustedPanelState(rawState) || rawState.view !== viewType) {
          panel.dispose();
          return;
        }
        await revive(panel, rawState as TState);
      },
    }),
  );
}

export function registerDisposePanelSerializer(context: vscode.ExtensionContext, viewType: string): void {
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(viewType, {
      async deserializeWebviewPanel(panel) {
        panel.dispose();
      },
    }),
  );
}

function isTrustedPanelState(value: unknown): value is TrustedPanelState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 && typeof record.view === "string";
}

import * as vscode from "vscode";

export interface TrustedPanelState {
  schemaVersion: 1;
  view: string;
}

export interface TrustedPanelReviveDeferral<TState extends TrustedPanelState> {
  shouldDefer(state: TState): boolean;
  onReady(callback: () => void): void;
}

export function registerTrustedPanelSerializer<TState extends TrustedPanelState>(
  context: vscode.ExtensionContext,
  viewType: string,
  revive: (panel: vscode.WebviewPanel, state: TState) => void | Promise<void>,
  options: { defer?: TrustedPanelReviveDeferral<TState> } = {},
): void {
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(viewType, {
      async deserializeWebviewPanel(panel, rawState) {
        if (!isTrustedPanelState(rawState) || rawState.view !== viewType) {
          panel.dispose();
          return;
        }
        const state = rawState as TState;
        const revivePanel = async (): Promise<void> => {
          try {
            await revive(panel, state);
          } catch (err) {
            panel.dispose();
            console.warn(`[tachyon] failed to revive webview panel '${viewType}'; disposing stale panel`, err);
          }
        };
        if (options.defer?.shouldDefer(state)) {
          let disposed = false;
          const sub = panel.onDidDispose(() => { disposed = true; });
          options.defer.onReady(() => {
            sub.dispose();
            if (!disposed) void revivePanel();
          });
          return;
        }
        await revivePanel();
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

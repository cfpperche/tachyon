import type * as vscode from "vscode";

/** Window-level authority for the project used by the next unscoped Control open. */
export class ControlWorkspaceScope implements vscode.Disposable {
  private selected: string | undefined;
  private readonly listeners = new Set<(value: string | undefined) => unknown>();
  readonly onDidChange = (listener: (value: string | undefined) => unknown): vscode.Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  get current(): string | undefined { return this.selected; }

  set(wsHash: string | undefined): void {
    const next = wsHash || undefined;
    if (next === this.selected) return;
    this.selected = next;
    for (const listener of this.listeners) listener(next);
  }

  dispose(): void { this.listeners.clear(); }
}

/** One extension-host instance per VS Code window/process. */
export const controlWorkspaceScope = new ControlWorkspaceScope();

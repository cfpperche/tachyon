import type * as vscode from "vscode";

/**
 * Window-level authority for the project in focus.
 *
 * t-72ff5a — it used to answer one question ("which project does the next unscoped Control open
 * belong to"). It now also decides which project seven of the sidebar's nine tabs are showing, so
 * two things changed around it. It is PERSISTED, because a selection that governs the whole sidebar
 * and resets to an arbitrary project on every window reload is not a selection. And no value of it
 * means "all workspaces" any more; `SidebarPrototype.resolveSelection` is what keeps it pointing at
 * a folder that is actually attached, including the first-ever open where nothing was stored.
 *
 * The store is `workspaceState`, not `globalState` where the sort and collapse prefs live: those are
 * one person's preferences and travel with them, while this is a folder hash that only means
 * anything in a window that has that folder open. Restoring another window's project into this one
 * would resolve away on the next push anyway — persisting per workspace just never proposes it.
 */
export class ControlWorkspaceScope implements vscode.Disposable {
  private selected: string | undefined;
  private store?: vscode.Memento;
  private storeKey = "tachyon.control.workspaceScope";
  private readonly listeners = new Set<(value: string | undefined) => unknown>();

  /**
   * Adopt a persisted selection and keep it written from here on.
   *
   * Called once at activation, BEFORE any surface reads the scope. It restores silently rather than
   * through `set()`: at this point nothing is listening, and a change event for a value that was
   * already the truth when the window closed would only cost an extra push.
   */
  attach(store: vscode.Memento): void {
    this.store = store;
    const restored = store.get<string>(this.storeKey);
    if (restored && !this.selected) this.selected = restored;
  }
  readonly onDidChange = (listener: (value: string | undefined) => unknown): vscode.Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  get current(): string | undefined { return this.selected; }

  set(wsHash: string | undefined): void {
    const next = wsHash || undefined;
    if (next === this.selected) return;
    this.selected = next;
    void this.store?.update(this.storeKey, next);
    for (const listener of this.listeners) listener(next);
  }

  dispose(): void { this.listeners.clear(); }
}

/** One extension-host instance per VS Code window/process. */
export const controlWorkspaceScope = new ControlWorkspaceScope();

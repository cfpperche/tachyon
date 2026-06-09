/**
 * Minimal vscode shim for vitest (aliased in vitest.config.ts). Unit-tested modules
 * are vscode-free by design; this exists so a transitive import never crashes.
 */
export const window = {
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  createTerminal: () => ({ show: () => {}, dispose: () => {} }),
  onDidCloseTerminal: () => ({ dispose: () => {} }),
  createStatusBarItem: () => ({ show: () => {}, dispose: () => {} }),
  showQuickPick: () => Promise.resolve(undefined),
};

export const workspace = {
  workspaceFolders: undefined,
  getConfiguration: () => ({ get: () => undefined }),
  createFileSystemWatcher: () => ({
    onDidChange: () => {},
    onDidCreate: () => {},
    onDidDelete: () => {},
    dispose: () => {},
  }),
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: () => Promise.resolve(undefined),
};

export const env = { clipboard: { writeText: () => Promise.resolve() } };

export enum ViewColumn {
  Active = -1,
  One = 1,
  Two = 2,
  Three = 3,
  Four = 4,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class RelativePattern {
  constructor(
    public base: string,
    public pattern: string,
  ) {}
}

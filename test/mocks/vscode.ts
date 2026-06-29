import path from "node:path";

/**
 * Minimal vscode shim for vitest (aliased in vitest.config.ts). Unit-tested modules
 * are vscode-free by design; this exists so a transitive import never crashes.
 */
export const __createdPanels: Array<{
  title: string;
  revealCount: number;
  disposed: boolean;
  webview: {
    html: string;
    options: unknown;
    posted: unknown[];
    asWebviewUri(uri: Uri): Uri;
    postMessage(msg: unknown): Promise<boolean>;
    onDidReceiveMessage(cb: (msg: unknown) => void): { dispose(): void };
    __receive(msg: unknown): void;
  };
  reveal(): void;
  dispose(): void;
  onDidDispose(cb: () => void): { dispose(): void };
}> = [];
const __executedCommands: Array<{ command: string; args: unknown[] }> = [];

export function __resetVscodeMock(): void {
  __createdPanels.splice(0);
  __executedCommands.splice(0);
  __openDialogResult = undefined;
  __clipboardText = "";
  __warningMessageResult = undefined;
}

let __openDialogResult: Uri[] | undefined;
let __clipboardText = "";
let __warningMessageResult: string | undefined;
export function __setOpenDialogResult(result: Uri[] | undefined): void {
  __openDialogResult = result;
}
export function __setWarningMessageResult(result: string | undefined): void {
  __warningMessageResult = result;
}
export function __getClipboardText(): string {
  return __clipboardText;
}
export function __getExecutedCommands(): Array<{ command: string; args: unknown[] }> {
  return [...__executedCommands];
}

export class Uri {
  constructor(public fsPath: string) {}
  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(path.join(base.fsPath, ...segments));
  }
  toString(): string {
    return this.fsPath;
  }
}

export const window = {
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(__warningMessageResult),
  showErrorMessage: () => Promise.resolve(undefined),
  showOpenDialog: () => Promise.resolve(__openDialogResult),
  createTerminal: () => ({ show: () => {}, dispose: () => {} }),
  onDidCloseTerminal: () => ({ dispose: () => {} }),
  createStatusBarItem: () => ({ show: () => {}, dispose: () => {} }),
  showQuickPick: () => Promise.resolve(undefined),
  createWebviewPanel: (_viewType: string, title: string, _showOptions?: unknown, options?: unknown) => {
    const messageHandlers: Array<(msg: unknown) => void> = [];
    const disposeHandlers: Array<() => void> = [];
    const panel = {
      title,
      revealCount: 0,
      disposed: false,
      webview: {
        html: "",
        options: options as unknown,
        posted: [] as unknown[],
        asWebviewUri: (uri: Uri) => uri,
        postMessage: async (msg: unknown) => { panel.webview.posted.push(msg); return true; },
        onDidReceiveMessage: (cb: (msg: unknown) => void) => {
          messageHandlers.push(cb);
          return { dispose() {} };
        },
        __receive: (msg: unknown) => { for (const cb of messageHandlers) cb(msg); },
      },
      reveal: () => { panel.revealCount += 1; },
      dispose: () => {
        panel.disposed = true;
        for (const cb of disposeHandlers) cb();
      },
      onDidDispose: (cb: () => void) => {
        disposeHandlers.push(cb);
        return { dispose() {} };
      },
    };
    __createdPanels.push(panel);
    return panel;
  },
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
  executeCommand: (command: string, ...args: unknown[]) => {
    __executedCommands.push({ command, args });
    return Promise.resolve(undefined);
  },
};

export const env = {
  clipboard: {
    writeText: (text: string) => {
      __clipboardText = text;
      return Promise.resolve();
    },
    readText: () => Promise.resolve(__clipboardText),
  },
  language: "en",
};

/** Pass-through l10n for unit tests — placeholders substituted like the real API. */
export const l10n = {
  t: (message: string, ...args: Array<string | number>) =>
    message.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? `{${i}}`)),
};

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

export class ThemeIcon {
  constructor(
    public id: string,
    public color?: unknown,
  ) {}
}

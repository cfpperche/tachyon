import path from "node:path";

/**
 * Minimal vscode shim for vitest (aliased in vitest.config.ts). Unit-tested modules
 * are vscode-free by design; this exists so a transitive import never crashes.
 */
export const __createdPanels: Array<{
  title: string;
  iconPath?: { light: Uri; dark: Uri };
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
export const __registeredWebviewPanelSerializers: Array<{
  viewType: string;
  serializer: {
    deserializeWebviewPanel(panel: typeof __createdPanels[number], state: unknown): Promise<void>;
  };
}> = [];
export const __createdTerminals: Array<{
  options: unknown;
  showCalls: boolean[];
  disposed: boolean;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}> = [];
const __executedCommands: Array<{ command: string; args: unknown[] }> = [];
const __warningMessageCalls: Array<{ message: string; options: unknown; actions: string[] }> = [];

export function __resetVscodeMock(): void {
  __createdPanels.splice(0);
  __registeredWebviewPanelSerializers.splice(0);
  __createdTerminals.splice(0);
  __executedCommands.splice(0);
  __warningMessageCalls.splice(0);
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
export function __getWarningMessageCalls(): Array<{ message: string; options: unknown; actions: string[] }> {
  return [...__warningMessageCalls];
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
  showWarningMessage: (message: string, ...args: unknown[]) => {
    const [first, ...rest] = args;
    const hasOptions = typeof first !== "string";
    __warningMessageCalls.push({
      message,
      options: hasOptions ? first : undefined,
      actions: (hasOptions ? rest : args).filter((arg): arg is string => typeof arg === "string"),
    });
    return Promise.resolve(__warningMessageResult);
  },
  showErrorMessage: () => Promise.resolve(undefined),
  showOpenDialog: () => Promise.resolve(__openDialogResult),
  createTerminal: (options?: unknown) => {
    const terminal = {
      options,
      showCalls: [] as boolean[],
      disposed: false,
      show: (preserveFocus = false) => { terminal.showCalls.push(preserveFocus); },
      dispose: () => { terminal.disposed = true; },
    };
    __createdTerminals.push(terminal);
    return terminal;
  },
  onDidCloseTerminal: () => ({ dispose: () => {} }),
  createStatusBarItem: () => ({ show: () => {}, dispose: () => {} }),
  showQuickPick: () => Promise.resolve(undefined),
  registerWebviewPanelSerializer: (viewType: string, serializer: { deserializeWebviewPanel(panel: typeof __createdPanels[number], state: unknown): Promise<void> }) => {
    __registeredWebviewPanelSerializers.push({ viewType, serializer });
    return { dispose() {} };
  },
  createWebviewPanel: (_viewType: string, title: string, _showOptions?: unknown, options?: unknown) => {
    const messageHandlers: Array<(msg: unknown) => void> = [];
    const disposeHandlers: Array<() => void> = [];
    const panel = {
      title,
      iconPath: undefined as { light: Uri; dark: Uri } | undefined,
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

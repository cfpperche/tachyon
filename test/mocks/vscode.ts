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
export type CreatedTerminalOptions = {
  name?: string;
  shellPath?: string;
  shellArgs?: string[];
  env?: Record<string, string>;
  location?: unknown;
  iconPath?: unknown;
  isTransient?: boolean;
  [key: string]: unknown;
};
export const __createdTerminals: Array<{
  options: CreatedTerminalOptions;
  showCalls: boolean[];
  disposed: boolean;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}> = [];
const __executedCommands: Array<{ command: string; args: unknown[] }> = [];
const __shownDocuments: Array<{ uri: Uri; options: unknown }> = [];
const __warningMessageCalls: Array<{ message: string; options: unknown; actions: string[] }> = [];
const __statusBarMessages: Array<{ text: string; timeout: number | undefined }> = [];
const __quickPickCalls: Array<{ items: readonly string[]; options: unknown }> = [];
const __terminalCloseListeners = new Set<(terminal: typeof __createdTerminals[number]) => void>();

export function __resetVscodeMock(): void {
  __configValues = {};
  __configListeners.length = 0;
  __fileWatchListeners.length = 0;
  __createdPanels.splice(0);
  __registeredWebviewPanelSerializers.splice(0);
  __createdTerminals.splice(0);
  __executedCommands.splice(0);
  __shownDocuments.splice(0);
  __warningMessageCalls.splice(0);
  __statusBarMessages.splice(0);
  __quickPickCalls.splice(0);
  __terminalCloseListeners.clear();
  __openDialogResult = undefined;
  __clipboardText = "";
  __warningMessageResult = undefined;
  __quickPickResult = undefined;
}

let __openDialogResult: Uri[] | undefined;
let __clipboardText = "";
let __warningMessageResult: string | undefined;
let __quickPickResult: string | undefined;
export function __setOpenDialogResult(result: Uri[] | undefined): void {
  __openDialogResult = result;
}
export function __setWarningMessageResult(result: string | undefined): void {
  __warningMessageResult = result;
}
export function __setQuickPickResult(result: string | undefined): void {
  __quickPickResult = result;
}
export function __getClipboardText(): string {
  return __clipboardText;
}
export function __getExecutedCommands(): Array<{ command: string; args: unknown[] }> {
  return [...__executedCommands];
}
export function __getShownDocuments(): Array<{ uri: Uri; options: unknown }> {
  return [...__shownDocuments];
}
export function __getWarningMessageCalls(): Array<{ message: string; options: unknown; actions: string[] }> {
  return [...__warningMessageCalls];
}
export function __getStatusBarMessages(): Array<{ text: string; timeout: number | undefined }> {
  return [...__statusBarMessages];
}
export function __getQuickPickCalls(): Array<{ items: readonly string[]; options: unknown }> {
  return [...__quickPickCalls];
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
  showTextDocument: (uri: Uri, options?: unknown) => {
    __shownDocuments.push({ uri, options });
    return Promise.resolve({});
  },
  showOpenDialog: () => Promise.resolve(__openDialogResult),
  createTerminal: (options?: CreatedTerminalOptions) => {
    const terminal = {
      options: options ?? {},
      showCalls: [] as boolean[],
      disposed: false,
      show: (preserveFocus = false) => { terminal.showCalls.push(preserveFocus); },
      dispose: () => {
        if (terminal.disposed) return;
        terminal.disposed = true;
        for (const listener of __terminalCloseListeners) listener(terminal);
      },
    };
    __createdTerminals.push(terminal);
    return terminal;
  },
  onDidCloseTerminal: (listener: (terminal: typeof __createdTerminals[number]) => void) => {
    __terminalCloseListeners.add(listener);
    return { dispose: () => __terminalCloseListeners.delete(listener) };
  },
  createStatusBarItem: () => ({ show: () => {}, dispose: () => {} }),
  setStatusBarMessage: (text: string, timeout?: number) => {
    __statusBarMessages.push({ text, timeout });
    return { dispose() {} };
  },
  showQuickPick: (items: readonly string[], options?: unknown) => {
    __quickPickCalls.push({ items, options });
    return Promise.resolve(__quickPickResult);
  },
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

/**
 * SDD 479 phase 5 — settings values a test wants the code under test to read. Keyed by the FULL id
 * (`git.path`), because that is what a reader composes from its section and key,
 * and a mock that only matched one of the two halves would pass for the wrong reason.
 */
let __configValues: Record<string, unknown> = {};
export function __setConfiguration(values: Record<string, unknown>): void {
  __configValues = { ...values };
}

/** Listeners registered via workspace.onDidChangeConfiguration, so a test can fire a change. */
const __configListeners: Array<(event: { affectsConfiguration(section: string): boolean }) => void> = [];
const __fileWatchListeners: Array<() => void> = [];

/** Fire every registered file watcher (the mock does not model paths; tests register exactly one). */
export function __fireFileWatch(): void {
  for (const listener of [...__fileWatchListeners]) listener();
}

export function __fireConfigurationChange(changed: string): void {
  for (const listener of [...__configListeners]) {
    listener({ affectsConfiguration: (section: string) => changed === section || changed.startsWith(`${section}.`) });
  }
}

export const workspace = {
  workspaceFolders: undefined,
  getConfiguration: (section?: string) => ({
    get: (key: string) => __configValues[section ? `${section}.${key}` : key],
  }),
  onDidChangeConfiguration: (listener: (event: { affectsConfiguration(section: string): boolean }) => void) => {
    __configListeners.push(listener);
    return {
      dispose: () => {
        const index = __configListeners.indexOf(listener);
        if (index >= 0) __configListeners.splice(index, 1);
      },
    };
  },
  // t-aaad95 — settings that used to arrive as configuration events now arrive as FILE events (the
  // global Tachyon settings file), so the mock has to be able to fire one.
  createFileSystemWatcher: () => {
    const watcher = {
      onDidChange: (listener: () => void) => { __fileWatchListeners.push(listener); return { dispose: () => {} }; },
      onDidCreate: (listener: () => void) => { __fileWatchListeners.push(listener); return { dispose: () => {} }; },
      onDidDelete: (listener: () => void) => { __fileWatchListeners.push(listener); return { dispose: () => {} }; },
      dispose: () => { __fileWatchListeners.length = 0; },
    };
    return watcher;
  },
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

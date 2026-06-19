import type { NotifyLevel } from "../bridge/tools.js";

/**
 * spec 233 — the host port the engine depends on instead of `vscode`. The VS Code shell implements it
 * (`VsCodeHost`); a CLI/daemon/other-IDE shell implements its own. The engine (Workspace + managers) must
 * never import `vscode` — it calls these small, composed ports. See `docs/system-design.md`.
 */

/** Which sidebar surface a change touches (the shell maps these to its own views). */
export type ViewKind = "agents" | "layouts" | "pins" | "commands" | "schedules";

/** A host-owned subscription the engine can cancel (vscode.Disposable shape, no vscode dependency). */
export interface HostDisposable {
  dispose(): void;
}

/** Which filesystem events a watch cares about. */
export interface WatchEvents {
  create?: boolean;
  change?: boolean;
  delete?: boolean;
}

/** Options for a single-line input prompt (mirrors the subset of vscode.InputBoxOptions the engine uses). */
export interface PromptInputOptions {
  prompt?: string;
  value?: string;
  placeHolder?: string;
  /** return undefined when valid, else the error message to show */
  validateInput?: (value: string) => string | undefined;
}

/** A captured editor arrangement (the raw layout + the agent name per visual group), host-produced. */
export interface LayoutSnapshot {
  raw: { orientation: number; groups: unknown[] };
  agentsByGroup: (string | undefined)[];
}

export interface EngineHost {
  // i18n — same call shape as vscode.l10n.t; a headless host does `{0}` substitution.
  t(message: string, ...args: (string | number | boolean)[]): string;

  // UiPort
  notify(message: string, level?: NotifyLevel): void;
  /** modal confirm with explicit action buttons; resolves to the chosen action (or undefined if dismissed). */
  confirm(message: string, ...actions: string[]): Promise<string | undefined>;
  promptInput(opts: PromptInputOptions): Promise<string | undefined>;

  // FileWatchPort — `glob` relative to `root`; the impl chooses vscode-watcher / chokidar / polling.
  watch(root: string, glob: string, events: WatchEvents, onEvent: () => void): HostDisposable;

  // SettingsPort
  getSetting<T>(section: string, key: string, dflt: T): T;

  // StoragePort — host-owned paths + persisted key/value + the engine's bundled media + app version.
  globalStoragePath(): string;
  getState<T>(key: string): T | undefined;
  setState(key: string, value: unknown): void;
  appVersion(): string;
  /** absolute path to a file the engine ships under its media dir (e.g. the clipboard helper). */
  mediaPath(...segments: string[]): string;
  /** opaque extension root handle the shell needs for webviews; the engine only passes it through. */
  webviewRoot(): unknown;

  // EditorLayoutPort — the only editor-command surface the engine needs (capture for "save layout as").
  captureLayout(): Promise<LayoutSnapshot>;

  // WorkspaceEvents
  onViewsChanged(view: ViewKind): void;
}

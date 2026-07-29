import type { NotifyLevel } from "../bridge/tools.js";
import type { TerminalPresentation, TerminalPresentationOptions } from "./TerminalPresentation.js";

/**
 * spec 233 — the host port the engine depends on instead of `vscode`. The VS Code shell implements it
 * (`VsCodeHost`); a CLI/daemon/other-IDE shell implements its own. The engine (Workspace + managers) must
 * never import `vscode` — it calls these small, composed ports. See `docs/system-design.md`.
 */

/** Which sidebar surface a change touches (the shell maps these to its own views). */
export type ViewKind = "agents" | "pins" | "tasks" | "commands" | "schedules" | "handoff" | "probes";

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

/**
 * An optional action offered alongside a notice. The engine supplies a label + what to DO; the shell
 * decides how to surface it (a toast button, a log line, nothing) and invokes `run` if the user picks it.
 * The engine never opens a window — it hands off a fact + the operations the user could take.
 */
export interface NoticeAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface EngineHost {
  // i18n — same call shape as vscode.l10n.t; a headless host does `{0}` substitution.
  t(message: string, ...args: (string | number | boolean)[]): string;

  // UiPort — a one-way "surface this message" sink (+ optional actions). NOT a window API: the engine
  // states a fact + offers operations; the shell renders it however it wants. No two-way dialogs here —
  // interactive features (prompting, layout capture) live entirely in the shell, not behind this port.
  notify(message: string, level?: NotifyLevel, actions?: NoticeAction[]): void;
  /** bring the shell's primary Tachyon view to focus (a one-way UI nudge; no-op for a headless host). */
  focusPrimaryView(): void;
  /** t-75fd3c — deep-link straight to a task's detail view (a one-way UI nudge; no-op for a headless host). */
  openTask(wsHash: string, taskId: string): void;
  /** stable host shim for adapter-internal VS Code commands; the engine never exposes this to agents directly. */
  executeCommand(command: string, ...args: unknown[]): Promise<unknown>;

  // FileWatchPort — `glob` relative to `root`; the impl chooses vscode-watcher / chokidar / polling.
  watch(root: string, glob: string, events: WatchEvents, onEvent: () => void): HostDisposable;

  /**
   * t-aaad95 — what is LEFT of the old generic SettingsPort, and deliberately not generic any more.
   *
   * Tachyon contributes no settings of its own; every one of them now lives in `tachyon.yml` or in
   * the global Tachyon file (`src/config/globalSettings.ts`), both of which the engine reads as plain
   * files with no shell involved. The single survivor is somebody ELSE's setting: the built-in Git
   * extension's `git.path`, consumed as a fallback when Tachyon's own `gitPath` is unset. Naming it
   * instead of keeping a `getSetting(section, key)` door is the point — a generic port is what let
   * eight readers grow around the abstraction in the first place, and a named one cannot.
   *
   * A host with no such notion (headless/CLI) returns undefined. A list means "first entry wins",
   * which is the shape VS Code's own key allows.
   */
  gitExtensionPath(): string | string[] | undefined;

  // StoragePort — host-owned paths + persisted key/value + the engine's bundled media + app version.
  globalStoragePath(): string;
  getState<T>(key: string): T | undefined;
  setState(key: string, value: unknown): void;
  appVersion(): string;

  // SecretPort (spec 351) — machine-local, never-synced secret custody (VS Code SecretStorage). Distinct
  // from getState/setState: those go through workspaceState (synced/backed up); this is the ONLY place the
  // engine may keep something like an HMAC key that must never leave the machine or land in a committable
  // or syncable file.
  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;
  /** absolute path to a file the engine ships under its media dir (e.g. the clipboard helper). */
  mediaPath(...segments: string[]): string;
  /** opaque extension root handle the shell needs for webviews; the engine only passes it through. */
  webviewRoot(): unknown;

  // ShellPresentationPort — optional because a daemon/headless host has no terminal-tab surface.
  // Workspace falls back to a headless implementation; the VS Code host supplies the real adapter.
  createTerminalPresentation?(options: TerminalPresentationOptions): TerminalPresentation;

  // WorkspaceEvents
  onViewsChanged(view: ViewKind): void;
}

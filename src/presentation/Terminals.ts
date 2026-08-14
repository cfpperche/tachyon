import fs from "node:fs";
import * as vscode from "vscode";
import type { EntryKind } from "@tachyon/engine/config/loadConfig.js";
import { SOCKET_NAME, socketPath, utf8LocaleEnv } from "@tachyon/engine/tmux/TmuxService.js";
import type { SessionViewportRegistry } from "./sessionViewport.js";
import type {
  TerminalManifestStore,
  TerminalPresentation,
  TerminalRestoreEntry,
} from "@tachyon/engine/workspace/TerminalPresentation.js";

export type { TerminalManifestStore, TerminalRestoreEntry } from "@tachyon/engine/workspace/TerminalPresentation.js";

/**
 * SDD 478 M5 — one icon per arm of the managed-entry union, exhaustively. A `Record<EntryKind, …>`
 * means a new arm fails to compile here instead of silently inheriting the robot, which is what the
 * old `kind === "terminal" ? … : "hubot"` ternary did.
 */
const ENTRY_ICON: Record<EntryKind, string> = { agent: "hubot", terminal: "terminal" };

/** The editor-tab icon for an opened session, by what it IS. ThemeIcons tint themselves with the tab
 *  foreground (active/inactive), unlike a custom SVG — so each kind reads clearly: an AI agent shows a
 *  robot, a terminal shows a terminal, a one-shot command a play glyph, a runbook an ordered list. */
function sessionIcon(agent: string, kind: EntryKind): vscode.ThemeIcon {
  if (agent.startsWith("cmd:")) return new vscode.ThemeIcon("play");
  if (agent.startsWith("rb:")) return new vscode.ThemeIcon("list-ordered");
  // t-2656d7 — a runtime login pane. Distinct from an agent tab on purpose: this is the one tab
  // where the human is expected to TYPE a credential step, and it must not be mistaken for a robot.
  if (agent.startsWith("login:")) return new vscode.ThemeIcon("key");
  return new vscode.ThemeIcon(ENTRY_ICON[kind]);
}

/**
 * Absolute tmux socket for editor attach (`-S`), not `-L` + ambient `TMUX_TMPDIR`.
 *
 * Dev Host F5 sets a private `TMUX_TMPDIR` on the Extension Host (launch.json), while the
 * persistent engine systemd unit historically did not receive that var and spawns on `/tmp`.
 * Attach with the EH's private TMPDIR then misses live sessions. Prefer a socket that exists.
 */
export function attachSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  },
): string {
  const bases: string[] = [];
  for (const candidate of [env.TACHYON_ENGINE_TMUX_TMPDIR, env.TMUX_TMPDIR, "/tmp"]) {
    if (!candidate) continue;
    const key = candidate.replace(/\/+$/, "");
    if (!bases.includes(key)) bases.push(key);
  }
  for (const base of bases) {
    const p = socketPath(SOCKET_NAME, { TMUX_TMPDIR: base });
    if (exists(p)) return p;
  }
  return socketPath(SOCKET_NAME, env);
}

/**
 * Displays managed entries as native VSCode terminals in the EDITOR AREA, each attached
 * to its tmux session. Attach uses -d (detach other clients) so a session re-opened
 * here never fights another client over geometry. Closing the terminal detaches;
 * it never kills the underlying process.
 */
export class Terminals implements TerminalPresentation {
  private bySession = new Map<string, { agent: string; terminal: vscode.Terminal }>();
  private programmaticClose = new WeakSet<vscode.Terminal>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly onReveal?: (agent: string, session: string) => void,
    /** Resolve an entry's kind (agent vs terminal) so the tab icon represents it. Defaults to "agent". */
    private readonly kindOf?: (agent: string) => "agent" | "terminal",
    private readonly manifest?: TerminalManifestStore,
    /** Manual shell-tab closure is an engine intent change, not merely local presentation cleanup. */
    private readonly onClosed?: (agent: string, session: string) => void,
    /**
     * t-feaaea — one exclusive tmux client per session. Without it, opening this terminal evicts a
     * live Agent Pane mid-redraw (dot fill, then `attach ended`); with it the pane lets go first.
     */
    private readonly viewports?: SessionViewportRegistry,
  ) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        for (const [session, entry] of this.bySession) {
          if (entry.terminal === terminal) {
            this.bySession.delete(session);
            this.viewports?.release(session, "terminal");
            this.saveManifest();
            if (!this.programmaticClose.has(terminal)) this.onClosed?.(entry.agent, session);
            break;
          }
        }
      }),
    );
  }

  /** Opens (or reveals) the editor-area terminal attached to a managed entry's tmux session. */
  open(agent: string, session: string, viewColumn?: number, title?: string): vscode.Terminal {
    // Claim BEFORE any tmux client exists: the outgoing viewport must be gone by the time
    // `attach-session -d` runs, or tmux paints its dot fill into it and then evicts it (t-feaaea).
    // The hook resolves the terminal lazily because at claim time it is not created yet.
    this.viewports?.claim(session, "terminal", () => this.releaseSession(session));
    const existing = this.bySession.get(session)?.terminal;
    if (existing) {
      existing.show(false);
      // A tab revealed after living hidden may hold a stale tmux client — redraw it.
      this.onReveal?.(agent, session);
      return existing;
    }
    const socket = attachSocketPath();
    const terminal = vscode.window.createTerminal({
      name: title ?? agent,
      // A contextual tab ICON (replaces VSCode's default `>_`): robot for an AI agent, terminal for a
      // shell/terminal, play for a one-shot command, ordered-list for a runbook. A ThemeIcon tints itself
      // with the tab foreground, so it stays legible active/inactive in every theme.
      iconPath: sessionIcon(agent, this.kindOf?.(agent) ?? "agent"),
      location: { viewColumn: viewColumn ?? vscode.ViewColumn.Active, preserveFocus: true },
      shellPath: "tmux",
      // -u forces UTF-8; -S pins the absolute socket so Dev Host's private TMUX_TMPDIR cannot
      // redirect attach away from the engine's real server (spec 389 dogfood / persistent engine).
      shellArgs: ["-u", "-S", socket, "attach-session", "-d", "-t", `=${session}`],
      env: utf8LocaleEnv(),
      // Don't let VSCode persist/revive this tab across window restarts — it would
      // come back as a plain bash ghost (the attach can't be restored by VSCode);
      // Tachyon itself re-attaches surviving agents on activation.
      isTransient: true,
    });
    this.bySession.set(session, { agent, terminal });
    this.saveManifestEntry(agent, session, viewColumn, title);
    terminal.show(true);
    return terminal;
  }

  close(agent: string, session?: string): void {
    const targets = session !== undefined
      ? [...this.bySession].filter(([candidate]) => candidate === session)
      : [...this.bySession].filter(([, entry]) => entry.agent === agent);
    for (const [candidate, entry] of targets) {
      this.programmaticClose.add(entry.terminal);
      entry.terminal.dispose();
      this.bySession.delete(candidate);
    }
    this.saveManifest();
  }

  /**
   * Hand this session's viewport to the Agent Pane (t-feaaea): drop the tab so its tmux client is
   * gone before the pane attaches. Unlike `close`, this is NOT marked programmatic — the tab really
   * stopped being presented, and the engine must hear that or it keeps a phantom terminal open.
   */
  private releaseSession(session: string): void {
    this.bySession.get(session)?.terminal.dispose();
  }

  has(agent: string): boolean {
    return [...this.bySession.values()].some((entry) => entry.agent === agent);
  }

  /** True when this agent's editor terminal is the one the user is focused on. */
  isActive(agent: string): boolean {
    return [...this.bySession.values()].some((entry) => entry.agent === agent && entry.terminal === vscode.window.activeTerminal);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    // Terminals themselves are left open — they're just views onto tmux.
  }

  async restoreOpen(hasSession: (session: string) => Promise<boolean>): Promise<void> {
    const entries = this.readManifest();
    let prunedMalformed = false;
    for (const entry of entries) {
      if (!isTerminalRestoreEntry(entry)) {
        prunedMalformed = true;
        continue;
      }
      if (this.bySession.has(entry.session)) continue;
      let live = false;
      try {
        live = await hasSession(entry.session);
      } catch {
        live = false;
      }
      if (!live) {
        continue;
      }
      this.open(entry.agent, entry.session, entry.viewColumn, entry.title);
    }
    if (prunedMalformed) this.saveManifestEntries(entries.filter(isTerminalRestoreEntry));
  }

  private saveManifestEntry(agent: string, session: string, viewColumn: number | undefined, title: string | undefined): void {
    if (!this.manifest) return;
    const entries: TerminalRestoreEntry[] = this.readManifest().filter((entry): entry is TerminalRestoreEntry => isTerminalRestoreEntry(entry) && entry.session !== session);
    entries.push({
      schemaVersion: 1,
      agent,
      session,
      ...(viewColumn !== undefined ? { viewColumn } : {}),
      ...(title !== undefined ? { title } : {}),
    });
    this.manifest.write(entries);
  }

  private saveManifest(): void {
    if (!this.manifest) return;
    const previous = this.readManifest().filter(isTerminalRestoreEntry);
    const openSessions = new Set(this.bySession.keys());
    this.manifest.write(previous.filter((entry) => openSessions.has(entry.session)));
  }

  private saveManifestEntries(entries: TerminalRestoreEntry[]): void {
    if (!this.manifest) return;
    this.manifest.write(entries);
  }

  private readManifest(): unknown[] {
    const entries = this.manifest?.read();
    return Array.isArray(entries) ? entries : [];
  }
}

function isTerminalRestoreEntry(value: unknown): value is TerminalRestoreEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && typeof record.agent === "string"
    && typeof record.session === "string"
    && (record.viewColumn === undefined || typeof record.viewColumn === "number")
    && (record.title === undefined || typeof record.title === "string");
}

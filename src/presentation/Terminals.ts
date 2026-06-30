import * as vscode from "vscode";
import { SOCKET_NAME, utf8LocaleEnv } from "../tmux/TmuxService.js";

/** The editor-tab icon for an opened session, by what it IS. ThemeIcons tint themselves with the tab
 *  foreground (active/inactive), unlike a custom SVG — so each kind reads clearly: an AI agent shows a
 *  robot, a terminal shows a terminal, a one-shot command a play glyph, a runbook an ordered list. */
function sessionIcon(agent: string, kind: "agent" | "terminal"): vscode.ThemeIcon {
  if (agent.startsWith("cmd:")) return new vscode.ThemeIcon("play");
  if (agent.startsWith("rb:")) return new vscode.ThemeIcon("list-ordered");
  return new vscode.ThemeIcon(kind === "terminal" ? "terminal" : "hubot");
}

/**
 * Displays managed entries as native VSCode terminals in the EDITOR AREA, each attached
 * to its tmux session. Attach uses -d (detach other clients) so a session re-opened
 * here never fights another client over geometry. Closing the terminal detaches;
 * it never kills the underlying process.
 */
export class Terminals {
  private byAgent = new Map<string, vscode.Terminal>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly onReveal?: (agent: string, session: string) => void,
    /** Resolve an entry's kind (agent vs terminal) so the tab icon represents it. Defaults to "agent". */
    private readonly kindOf?: (agent: string) => "agent" | "terminal",
  ) {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        for (const [agent, t] of this.byAgent) {
          if (t === terminal) {
            this.byAgent.delete(agent);
            break;
          }
        }
      }),
    );
  }

  /** Opens (or reveals) the editor-area terminal attached to a managed entry's tmux session. */
  open(agent: string, session: string, viewColumn?: vscode.ViewColumn, title?: string): vscode.Terminal {
    const existing = this.byAgent.get(agent);
    if (existing) {
      existing.show(false);
      // A tab revealed after living hidden may hold a stale tmux client — redraw it.
      this.onReveal?.(agent, session);
      return existing;
    }
    const terminal = vscode.window.createTerminal({
      name: title ?? agent,
      // A contextual tab ICON (replaces VSCode's default `>_`): robot for an AI agent, terminal for a
      // shell/terminal, play for a one-shot command, ordered-list for a runbook. A ThemeIcon tints itself
      // with the tab foreground, so it stays legible active/inactive in every theme.
      iconPath: sessionIcon(agent, this.kindOf?.(agent) ?? "agent"),
      location: { viewColumn: viewColumn ?? vscode.ViewColumn.Active, preserveFocus: true },
      shellPath: "tmux",
      // -u forces UTF-8 rendering even if locale detection fails; the env override
      // backstops it so the attach client itself runs in a UTF-8 locale (mojibake fix).
      shellArgs: ["-u", "-L", SOCKET_NAME, "attach-session", "-d", "-t", `=${session}`],
      env: utf8LocaleEnv(),
      // Don't let VSCode persist/revive this tab across window restarts — it would
      // come back as a plain bash ghost (the attach can't be restored by VSCode);
      // Tachyon itself re-attaches surviving agents on activation.
      isTransient: true,
    });
    this.byAgent.set(agent, terminal);
    terminal.show(true);
    return terminal;
  }

  close(agent: string): void {
    this.byAgent.get(agent)?.dispose();
    this.byAgent.delete(agent);
  }

  has(agent: string): boolean {
    return this.byAgent.has(agent);
  }

  /** True when this agent's editor terminal is the one the user is focused on. */
  isActive(agent: string): boolean {
    const t = this.byAgent.get(agent);
    return t !== undefined && t === vscode.window.activeTerminal;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    // Terminals themselves are left open — they're just views onto tmux.
  }
}

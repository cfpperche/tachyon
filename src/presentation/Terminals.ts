import * as vscode from "vscode";
import { SOCKET_NAME, utf8LocaleEnv } from "../tmux/TmuxService.js";

/**
 * Displays agents as native VSCode terminals in the EDITOR AREA, each attached to
 * its tmux session. Attach uses -d (detach other clients) so a session re-opened
 * here never fights another client over geometry. Closing the terminal detaches;
 * it never kills the agent.
 */
export class Terminals {
  private byAgent = new Map<string, vscode.Terminal>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly onReveal?: (agent: string, session: string) => void) {
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

  /** Opens (or reveals) the editor-area terminal attached to an agent's session. */
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
      // The Tachyon brand bolt as the tab ICON (replaces VSCode's default `>_`), instead of a ⚡
      // character glued into the title — which left an ugly `>_ ⚡ name` double-icon in the editor tab.
      iconPath: new vscode.ThemeIcon("zap"),
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

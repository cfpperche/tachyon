import * as vscode from "vscode";
import { SOCKET_NAME } from "../tmux/TmuxService.js";

/**
 * Displays agents as native VSCode terminals in the EDITOR AREA, each attached to
 * its tmux session. Attach uses -d (detach other clients) so a session re-opened
 * here never fights another client over geometry. Closing the terminal detaches;
 * it never kills the agent.
 */
export class Terminals {
  private byAgent = new Map<string, vscode.Terminal>();
  private disposables: vscode.Disposable[] = [];

  constructor() {
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
  open(agent: string, session: string, viewColumn?: vscode.ViewColumn): vscode.Terminal {
    const existing = this.byAgent.get(agent);
    if (existing) {
      existing.show(false);
      return existing;
    }
    const terminal = vscode.window.createTerminal({
      name: `⚡ ${agent}`,
      location: { viewColumn: viewColumn ?? vscode.ViewColumn.Active, preserveFocus: true },
      shellPath: "tmux",
      shellArgs: ["-L", SOCKET_NAME, "attach-session", "-d", "-t", `=${session}`],
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

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    // Terminals themselves are left open — they're just views onto tmux.
  }
}

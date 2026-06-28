import * as vscode from "vscode";

/**
 * spec 282 — the contextual editor-tab icon for a webview panel. A codicon SVG (shipped under media/icons/) that
 * uses `fill="currentColor"`, so VS Code themes it with the tab foreground. Replaces VS Code's generic default
 * webview tab icon with one that represents what the view IS (agent-studio→hubot, plugins→extensions, …).
 */
export function panelIcon(extensionUri: vscode.Uri, name: string): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, "media", "icons", `${name}.svg`);
}

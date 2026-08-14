import * as vscode from "vscode";

/**
 * spec 282 — the contextual editor-tab icon for a webview panel. A codicon shipped under media/icons/ that
 * represents what the view IS (agent-studio→hubot, plugins→extensions, …), replacing VS Code's generic default
 * webview tab icon.
 *
 * WebviewPanel.iconPath accepts only a Uri (no ThemeIcon), so a custom SVG is rendered LITERALLY — `currentColor`
 * has no theme context there and collapses to near-black (invisible on dark themes). Hence the {light, dark}
 * pair: an explicit dark fill (#424242) for light themes, a light fill (#C5C5C5) for dark themes — the same two
 * colors VS Code uses for its own product icons.
 */
export function panelIcon(extensionUri: vscode.Uri, name: string): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.joinPath(extensionUri, "media", "icons", "light", `${name}.svg`),
    dark: vscode.Uri.joinPath(extensionUri, "media", "icons", "dark", `${name}.svg`),
  };
}

// spec 252 — VS Code theme token sets for the design-system render harness. Two realistic `--vscode-*`
// variable sets (Dark Modern / Light Modern) so a panel can be screenshotted under BOTH a dark AND a light
// theme (decision D3). The whole point: a light set exposes any hardcoded dark hex that breaks light (D4).
// These are approximations of the stock VS Code default themes — enough to prove "the look follows the theme".

export const THEMES = {
  dark: {
    "--vscode-font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    "--vscode-font-size": "13px",
    "--vscode-editor-font-family": "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
    "--vscode-foreground": "#cccccc",
    "--vscode-descriptionForeground": "#989898",
    "--vscode-editor-background": "#1f1f1f",
    "--vscode-editorWidget-background": "#252526",
    "--vscode-editorWidget-border": "#454545",
    "--vscode-widget-border": "#313131",
    "--vscode-focusBorder": "#0078d4",
    "--vscode-textLink-foreground": "#4daafc",
    "--vscode-button-background": "#0078d4",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#026ec1",
    "--vscode-input-background": "#313131",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-toolbar-hoverBackground": "rgba(90,93,94,0.31)",
    "--vscode-charts-green": "#89d185",
    "--vscode-charts-yellow": "#cca700",
    "--vscode-charts-blue": "#3794ff",
    "--vscode-charts-red": "#f14c4c",
    "--vscode-errorForeground": "#f14c4c",
    "--vscode-list-warningForeground": "#cca700",
    "--vscode-list-errorForeground": "#f14c4c",
    "--vscode-testing-iconPassed": "#73c991",
    "--vscode-terminal-ansiGreen": "#0dbc79",
    "--vscode-terminal-ansiYellow": "#e5e510",
    "--vscode-terminal-ansiRed": "#cd3131",
    "--vscode-diffEditor-insertedTextBackground": "rgba(155,185,85,0.20)",
  },
  light: {
    "--vscode-font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    "--vscode-font-size": "13px",
    "--vscode-editor-font-family": "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
    "--vscode-foreground": "#3b3b3b",
    "--vscode-descriptionForeground": "#767676",
    "--vscode-editor-background": "#ffffff",
    "--vscode-editorWidget-background": "#f8f8f8",
    "--vscode-editorWidget-border": "#cecece",
    "--vscode-widget-border": "#cecece",
    "--vscode-focusBorder": "#005fb8",
    "--vscode-textLink-foreground": "#005fb8",
    "--vscode-button-background": "#005fb8",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#0258a8",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#3b3b3b",
    "--vscode-toolbar-hoverBackground": "rgba(184,184,184,0.31)",
    "--vscode-charts-green": "#388a34",
    "--vscode-charts-yellow": "#855f00",
    "--vscode-charts-blue": "#1a85ff",
    "--vscode-charts-red": "#e51400",
    "--vscode-errorForeground": "#e51400",
    "--vscode-list-warningForeground": "#855f00",
    "--vscode-list-errorForeground": "#e51400",
    "--vscode-testing-iconPassed": "#388a34",
    "--vscode-terminal-ansiGreen": "#00bc00",
    "--vscode-terminal-ansiYellow": "#949800",
    "--vscode-terminal-ansiRed": "#cd3131",
    "--vscode-diffEditor-insertedTextBackground": "rgba(155,185,85,0.20)",
  },
};

/** Render a theme's tokens as a `:root { ... }` CSS block. */
export function themeRootCss(name) {
  const t = THEMES[name];
  const body = Object.entries(t).map(([k, v]) => `  ${k}: ${v};`).join("\n");
  return `:root {\n${body}\n}`;
}

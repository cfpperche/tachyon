import type { ITheme } from "@xterm/xterm";

const ANSI_ROLES = {
  black: "ansiBlack", red: "ansiRed", green: "ansiGreen", yellow: "ansiYellow",
  blue: "ansiBlue", magenta: "ansiMagenta", cyan: "ansiCyan", white: "ansiWhite",
  brightBlack: "ansiBrightBlack", brightRed: "ansiBrightRed", brightGreen: "ansiBrightGreen",
  brightYellow: "ansiBrightYellow", brightBlue: "ansiBrightBlue", brightMagenta: "ansiBrightMagenta",
  brightCyan: "ansiBrightCyan", brightWhite: "ansiBrightWhite",
} as const;

/** Read xterm's palette from the same computed VS Code theme that paints the pane chrome. */
export function terminalThemeFromComputedStyle(style: Pick<CSSStyleDeclaration, "getPropertyValue">): ITheme {
  const read = (name: string): string => style.getPropertyValue(name).trim();
  const foreground = read("--vscode-editor-foreground") || read("--vscode-foreground");
  const theme: ITheme = {
    background: read("--vscode-editor-background"),
    foreground,
    cursor: read("--vscode-terminalCursor-foreground") || foreground,
    selectionBackground: read("--vscode-terminal-selectionBackground") || read("--vscode-editor-selectionBackground"),
  };
  for (const [xtermRole, vscodeRole] of Object.entries(ANSI_ROLES)) {
    theme[xtermRole as keyof typeof ANSI_ROLES] = read(`--vscode-terminal-${vscodeRole}`) || foreground;
  }
  return theme;
}

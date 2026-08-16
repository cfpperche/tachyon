import type { ITheme } from "@xterm/xterm";

const ANSI_ROLES = {
  black: "ansiBlack", red: "ansiRed", green: "ansiGreen", yellow: "ansiYellow",
  blue: "ansiBlue", magenta: "ansiMagenta", cyan: "ansiCyan", white: "ansiWhite",
  brightBlack: "ansiBrightBlack", brightRed: "ansiBrightRed", brightGreen: "ansiBrightGreen",
  brightYellow: "ansiBrightYellow", brightBlue: "ansiBrightBlue", brightMagenta: "ansiBrightMagenta",
  brightCyan: "ansiBrightCyan", brightWhite: "ansiBrightWhite",
} as const;

export type ThemeColorPair = { roles: [string, string]; value: string };

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

/** Exact same-value collisions. A theme that publishes two identical roles is a finding, not a defect to invent around. */
export function indistinguishableColorPairs(theme: ITheme): ThemeColorPair[] {
  const byValue = new Map<string, string[]>();
  for (const [role, raw] of Object.entries(theme)) {
    if (typeof raw !== "string") continue;
    const value = raw.trim().toLowerCase();
    if (!value) continue;
    const roles = byValue.get(value) ?? [];
    roles.push(role);
    byValue.set(value, roles);
  }
  const pairs: ThemeColorPair[] = [];
  for (const [value, roles] of byValue) {
    for (let i = 0; i < roles.length; i++) {
      for (let j = i + 1; j < roles.length; j++) {
        pairs.push({ roles: [roles[i]!, roles[j]!], value });
      }
    }
  }
  return pairs;
}

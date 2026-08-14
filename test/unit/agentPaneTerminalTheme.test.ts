import { describe, expect, it } from "vitest";
import { terminalThemeFromComputedStyle } from "../../src/webview/agent-pane/terminalTheme.js";

describe("Agent Pane terminal theme", () => {
  it("reads editor background/foreground and every ANSI role from a light VS Code theme", () => {
    const vars = new Map<string, string>([
      ["--vscode-editor-background", "#ffffff"],
      ["--vscode-editor-foreground", "#333333"],
      ...["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White",
        "BrightBlack", "BrightRed", "BrightGreen", "BrightYellow", "BrightBlue", "BrightMagenta", "BrightCyan", "BrightWhite"]
        .map((role, index) => [`--vscode-terminal-ansi${role}`, `rgb(${index}, ${index + 1}, ${index + 2})`] as [string, string]),
    ]);
    const theme = terminalThemeFromComputedStyle({ getPropertyValue: (name) => vars.get(name) ?? "" });
    expect(theme.background).toBe("#ffffff");
    expect(theme.foreground).toBe("#333333");
    expect(theme.black).toBe("rgb(0, 1, 2)");
    expect(theme.brightWhite).toBe("rgb(15, 16, 17)");
    expect(new Set(Object.values(theme).filter(Boolean)).size).toBeGreaterThanOrEqual(18);
  });

  it("records the measured Dark+ indistinguishable pair instead of inventing a replacement", () => {
    const darkPlus = {
      black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
      blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
      brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b", brightYellow: "#f5f543",
      brightBlue: "#3b8eea", brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#e5e5e5",
    };
    const vscodeVars = new Map(Object.entries(darkPlus).map(([role, value]) => [
      `--vscode-terminal-ansi${role[0]!.toUpperCase()}${role.slice(1)}`,
      value,
    ]));
    const theme = terminalThemeFromComputedStyle({ getPropertyValue: (name) => vscodeVars.get(name) ?? "" });
    expect(theme.white).toBe("#e5e5e5");
    expect(theme.brightWhite).toBe(theme.white);
  });
});

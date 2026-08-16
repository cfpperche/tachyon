import { describe, expect, it } from "vitest";
import {
  indistinguishableColorPairs,
  terminalThemeFromComputedStyle,
} from "@tachyon/webview-ui/webview/agent-pane/terminalTheme.js";

/**
 * The 21 literals that used to live in App.tsx (pre t-55310f). They are a verbatim copy of
 * VS Code 1.133's dark terminal defaults (`src/vs/workbench/contrib/terminal/common/terminalColorRegistry.ts`)
 * plus Dark+ editor ground/cursor/selection — not an independently designed pairwise set.
 */
const ORIGINAL_LITERALS = {
  background: "#1e1e1e",
  foreground: "#cccccc",
  cursor: "#aeafad",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
} as const;

/** Official 1.133 `ansiColorMap` dark defaults. */
const VSCODE_1_133_DARK_ANSI = {
  black: "#000000", red: "#cd3131", green: "#0DBC79", yellow: "#e5e510",
  blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
  brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b", brightYellow: "#f5f543",
  brightBlue: "#3b8eea", brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#e5e5e5",
} as const;

/** Official 1.133 `ansiColorMap` light defaults. */
const VSCODE_1_133_LIGHT_ANSI = {
  black: "#000000", red: "#cd3131", green: "#107C10", yellow: "#949800",
  blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
  brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14CE14", brightYellow: "#b5ba00",
  brightBlue: "#0451a5", brightMagenta: "#bc05bc", brightCyan: "#0598bc", brightWhite: "#a5a5a5",
} as const;

function asVscodeVars(
  ansi: Record<string, string>,
  extras: Record<string, string> = {},
): Map<string, string> {
  const vars = new Map<string, string>(Object.entries(extras));
  for (const [role, value] of Object.entries(ansi)) {
    vars.set(`--vscode-terminal-ansi${role[0]!.toUpperCase()}${role.slice(1)}`, value);
  }
  return vars;
}

function relativeLuminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

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

  it("the original 21 literals were Dark+ / 1.133 dark defaults, chosen against the dark ground, not as a unique pairwise set", () => {
    for (const role of Object.keys(VSCODE_1_133_DARK_ANSI) as (keyof typeof VSCODE_1_133_DARK_ANSI)[]) {
      expect(ORIGINAL_LITERALS[role].toLowerCase()).toBe(VSCODE_1_133_DARK_ANSI[role].toLowerCase());
    }
    expect(ORIGINAL_LITERALS.white).toBe(ORIGINAL_LITERALS.brightWhite);
    const againstGround = (["red", "green", "yellow", "blue", "magenta", "cyan"] as const)
      .map((role) => ({ role, contrast: contrastRatio(ORIGINAL_LITERALS[role], ORIGINAL_LITERALS.background) }));
    // Every hue is brighter than the Dark+ ground it was copied onto. black-on-#1e1e1e is not:
    // that role is a cell fill, not text, which is how a terminal palette works.
    expect(againstGround.every((row) => row.contrast > 2)).toBe(true);
    expect(contrastRatio(ORIGINAL_LITERALS.black, ORIGINAL_LITERALS.background)).toBeLessThan(1.3);
  });

  it("records the measured Dark+ indistinguishable pair instead of inventing a replacement", () => {
    const vscodeVars = asVscodeVars(VSCODE_1_133_DARK_ANSI);
    const theme = terminalThemeFromComputedStyle({ getPropertyValue: (name) => vscodeVars.get(name) ?? "" });
    expect(theme.white?.toLowerCase()).toBe("#e5e5e5");
    expect(theme.brightWhite).toBe(theme.white);
    expect(indistinguishableColorPairs(theme)).toEqual([
      { roles: ["white", "brightWhite"], value: "#e5e5e5" },
    ]);
  });

  it("records the measured Light+ indistinguishable pairs instead of inventing replacements", () => {
    const vscodeVars = asVscodeVars(VSCODE_1_133_LIGHT_ANSI, {
      "--vscode-editor-background": "#ffffff",
      "--vscode-editor-foreground": "#333333",
      "--vscode-terminalCursor-foreground": "#007acc",
    });
    const theme = terminalThemeFromComputedStyle({ getPropertyValue: (name) => vscodeVars.get(name) ?? "" });
    expect(theme.background).toBe("#ffffff");
    const pairs = indistinguishableColorPairs(theme);
    expect(pairs).toEqual([
      { roles: ["red", "brightRed"], value: "#cd3131" },
      { roles: ["blue", "brightBlue"], value: "#0451a5" },
      { roles: ["magenta", "brightMagenta"], value: "#bc05bc" },
      { roles: ["cyan", "brightCyan"], value: "#0598bc" },
    ]);
  });
});

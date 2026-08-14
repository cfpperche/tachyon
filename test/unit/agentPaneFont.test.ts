import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  ensureMonoFontStack,
  quoteFontFamily,
  resolveAgentPaneFontMetrics,
  type TerminalFontConfigSource,
} from "../../apps/vscode-extension/src/presentation/agentPaneFont.js";

function cfg(map: Record<string, unknown>): TerminalFontConfigSource {
  return {
    get<T>(section: string, defaultValue: T): T {
      return (section in map ? map[section] : defaultValue) as T;
    },
  };
}

describe("quoteFontFamily", () => {
  it("quotes multi-word faces for canvas font shorthand", () => {
    expect(quoteFontFamily("JetBrainsMono Nerd Font")).toBe('"JetBrainsMono Nerd Font"');
    expect(quoteFontFamily("DejaVu Sans Mono")).toBe('"DejaVu Sans Mono"');
  });

  it("leaves generic families and simple identifiers unquoted", () => {
    expect(quoteFontFamily("monospace")).toBe("monospace");
    expect(quoteFontFamily("Menlo")).toBe("Menlo");
  });
});

describe("ensureMonoFontStack", () => {
  it("appends mono fallbacks when user face is bare (Windows-only Nerd Font)", () => {
    const stack = ensureMonoFontStack("JetBrainsMono Nerd Font");
    expect(stack.startsWith('"JetBrainsMono Nerd Font"')).toBe(true);
    expect(stack).toContain("DejaVu Sans Mono");
    expect(stack).toMatch(/monospace\s*$/);
  });

  it("still guarantees mono fallbacks when preferred already ends with monospace", () => {
    const stack = ensureMonoFontStack("Cascadia Mono, monospace");
    expect(stack).toContain("Cascadia Mono");
    expect(stack).toContain("DejaVu Sans Mono");
    expect(stack).toMatch(/monospace\s*$/);
  });

  it("strips Tachyon Mono and keeps mono fallbacks", () => {
    const stack = ensureMonoFontStack("Tachyon Mono, monospace");
    expect(stack.toLowerCase()).not.toContain("tachyon mono");
    expect(stack).toContain("DejaVu Sans Mono");
  });
});

describe("resolveAgentPaneFontMetrics", () => {
  it("prefers terminal.integrated.fontFamily over editor and appends mono fallbacks", () => {
    const m = resolveAgentPaneFontMetrics(
      cfg({ fontFamily: "Cascadia Mono, monospace", fontSize: 13 }),
      cfg({ fontFamily: "Fira Code", fontSize: 16 }),
    );
    expect(m.fontFamily).toContain("Cascadia Mono");
    expect(m.fontFamily).toContain("DejaVu Sans Mono");
    expect(m.fontSize).toBe(13);
  });

  it("falls back to editor font when terminal fontFamily is empty", () => {
    const m = resolveAgentPaneFontMetrics(
      cfg({ fontFamily: "", fontSize: 0 }),
      cfg({ fontFamily: "'JetBrains Mono', monospace", fontSize: 15 }),
    );
    expect(m.fontFamily).toContain("JetBrains Mono");
    expect(m.fontFamily).toContain("DejaVu Sans Mono");
    expect(m.fontSize).toBe(15);
  });

  it("rejects Tachyon Mono (missing @font-face in bare webview) for system stack", () => {
    const m = resolveAgentPaneFontMetrics(
      cfg({ fontFamily: "Tachyon Mono, monospace", fontSize: 14 }),
    );
    expect(m.fontFamily.toLowerCase()).not.toContain("tachyon mono");
    expect(m.fontFamily).toContain("DejaVu Sans Mono");
  });

  it("uses default stack when both empty", () => {
    const m = resolveAgentPaneFontMetrics(cfg({}), cfg({}));
    expect(m.fontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(m.fontSize).toBe(14);
  });

  it("pins letterSpacing and lineHeight for full-screen TUI packing", () => {
    const mild = resolveAgentPaneFontMetrics(
      cfg({ fontSize: 12, lineHeight: 1.1, letterSpacing: 1, fontWeight: "400", fontWeightBold: "700" }),
    );
    expect(mild.lineHeight).toBe(1);
    expect(mild.letterSpacing).toBe(0);
    const wild = resolveAgentPaneFontMetrics(
      cfg({ fontSize: 12, lineHeight: 2, letterSpacing: 8 }),
    );
    expect(wild.lineHeight).toBe(1);
    expect(wild.letterSpacing).toBe(0);
  });

  it("turns bare JetBrainsMono Nerd Font into a mono-safe stack (dogfood root cause)", () => {
    const m = resolveAgentPaneFontMetrics(
      cfg({ fontFamily: "JetBrainsMono Nerd Font", fontSize: 15 }),
    );
    // First face preserved (Windows host may have it); fallbacks save WSL webview.
    expect(m.fontFamily.startsWith('"JetBrainsMono Nerd Font"')).toBe(true);
    expect(m.fontFamily).toContain("DejaVu Sans Mono");
    expect(m.letterSpacing).toBe(0);
  });
});

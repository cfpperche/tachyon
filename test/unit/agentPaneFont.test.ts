import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  resolveAgentPaneFontMetrics,
  type TerminalFontConfigSource,
} from "../../src/presentation/agentPaneFont.js";

function cfg(map: Record<string, unknown>): TerminalFontConfigSource {
  return {
    get<T>(section: string, defaultValue: T): T {
      return (section in map ? map[section] : defaultValue) as T;
    },
  };
}

describe("resolveAgentPaneFontMetrics", () => {
  it("prefers terminal.integrated.fontFamily over editor", () => {
    const m = resolveAgentPaneFontMetrics(
      cfg({ fontFamily: "Cascadia Mono, monospace", fontSize: 13 }),
      cfg({ fontFamily: "Fira Code", fontSize: 16 }),
    );
    expect(m.fontFamily).toBe("Cascadia Mono, monospace");
    expect(m.fontSize).toBe(13);
  });

  it("falls back to editor font when terminal fontFamily is empty", () => {
    const m = resolveAgentPaneFontMetrics(
      cfg({ fontFamily: "", fontSize: 0 }),
      cfg({ fontFamily: "'JetBrains Mono', monospace", fontSize: 15 }),
    );
    expect(m.fontFamily).toBe("'JetBrains Mono', monospace");
    expect(m.fontSize).toBe(15);
  });

  it("rejects Tachyon Mono (missing @font-face in bare webview) for system stack", () => {
    const m = resolveAgentPaneFontMetrics(
      cfg({ fontFamily: "Tachyon Mono, monospace", fontSize: 14 }),
    );
    expect(m.fontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
  });

  it("uses default stack when both empty", () => {
    const m = resolveAgentPaneFontMetrics(cfg({}), cfg({}));
    expect(m.fontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(m.fontSize).toBe(14);
  });

  it("passes mild lineHeight/letterSpacing; clamps TUI-unsafe values", () => {
    const mild = resolveAgentPaneFontMetrics(
      cfg({ fontSize: 12, lineHeight: 1.1, letterSpacing: 1, fontWeight: "400", fontWeightBold: "700" }),
    );
    expect(mild.lineHeight).toBe(1.1);
    expect(mild.letterSpacing).toBe(1);
    const wild = resolveAgentPaneFontMetrics(
      cfg({ fontSize: 12, lineHeight: 2, letterSpacing: 8 }),
    );
    expect(wild.lineHeight).toBe(1);
    expect(wild.letterSpacing).toBe(0);
  });
});

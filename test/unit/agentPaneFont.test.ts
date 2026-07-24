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

  it("uses default stack when both empty", () => {
    const m = resolveAgentPaneFontMetrics(cfg({}), cfg({}));
    expect(m.fontFamily).toBe(DEFAULT_TERMINAL_FONT_FAMILY);
    expect(m.fontSize).toBe(14);
  });

  it("passes lineHeight and letterSpacing from terminal settings", () => {
    const m = resolveAgentPaneFontMetrics(
      cfg({ fontSize: 12, lineHeight: 1.2, letterSpacing: 1, fontWeight: "400", fontWeightBold: "700" }),
    );
    expect(m.lineHeight).toBe(1.2);
    expect(m.letterSpacing).toBe(1);
    expect(m.fontWeight).toBe("400");
    expect(m.fontWeightBold).toBe("700");
  });
});

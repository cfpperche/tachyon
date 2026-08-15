import { describe, expect, it } from "vitest";
import {
  computeGrid,
  gridChanged,
  sanitizeFontMetrics,
  MIN_COLS,
  MIN_ROWS,
} from "@tachyon/webview-ui/webview/agent-pane/geometry.js";

describe("computeGrid", () => {
  it("floors container pixels into cols×rows", () => {
    expect(computeGrid(800, 600, { cellWidth: 10, cellHeight: 20 })).toEqual({
      cols: 80,
      rows: 30,
    });
  });

  it("never claims partial cells (floor)", () => {
    expect(computeGrid(805, 615, { cellWidth: 10, cellHeight: 20 })).toEqual({
      cols: 80,
      rows: 30,
    });
  });

  it("clamps to minimum viable TUI size", () => {
    expect(computeGrid(1, 1, { cellWidth: 10, cellHeight: 20 })).toEqual({
      cols: MIN_COLS,
      rows: MIN_ROWS,
    });
  });
});

describe("gridChanged", () => {
  it("detects dimension changes only", () => {
    expect(gridChanged({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false);
    expect(gridChanged({ cols: 80, rows: 24 }, { cols: 100, rows: 24 })).toBe(true);
  });
});

describe("sanitizeFontMetrics", () => {
  it("pins letterSpacing to 0 so TUIs do not look double-spaced", () => {
    const s = sanitizeFontMetrics({
      fontFamily: " Cascadia Mono ",
      fontSize: 14,
      fontWeight: "normal",
      fontWeightBold: "bold",
      lineHeight: 1,
      letterSpacing: 8,
    });
    expect(s.letterSpacing).toBe(0);
    expect(s.fontFamily).toBe("Cascadia Mono");
  });

  it("pins lineHeight to 1 for full-screen TUI packing", () => {
    expect(
      sanitizeFontMetrics({
        fontFamily: "monospace",
        fontSize: 14,
        fontWeight: "normal",
        fontWeightBold: "bold",
        lineHeight: 3,
        letterSpacing: 0,
      }).lineHeight,
    ).toBe(1);
  });
});

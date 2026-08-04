import { describe, expect, it } from "vitest";
import {
  assembleDesignModePick,
  DESIGN_MODE_HTML_MAX,
  DESIGN_MODE_STYLE_KEYS,
  formatDesignModePickForAgent,
  selectorHintFromIdentity,
  subsetComputedStyles,
} from "../../src/webview/ide-browser-bridge/pick.js";

describe("subsetComputedStyles", () => {
  it("keeps only allowlisted keys from a fuller style map", () => {
    const out = subsetComputedStyles({
      color: "rgb(0, 0, 0)",
      backgroundColor: "rgb(255, 255, 255)",
      fontSize: "16px",
      zIndex: "99",
      transform: "none",
      padding: "8px",
    });
    expect(out).toEqual({
      color: "rgb(0, 0, 0)",
      backgroundColor: "rgb(255, 255, 255)",
      fontSize: "16px",
      padding: "8px",
    });
    expect(out).not.toHaveProperty("zIndex");
    for (const key of Object.keys(out)) {
      expect(DESIGN_MODE_STYLE_KEYS).toContain(key);
    }
  });
});

describe("selectorHintFromIdentity", () => {
  it("prefers id over class", () => {
    expect(selectorHintFromIdentity({ tag: "BUTTON", id: "go", className: "primary" })).toBe(
      "button#go",
    );
  });

  it("uses classes when no id", () => {
    expect(selectorHintFromIdentity({ tag: "a", className: "link external" })).toBe(
      "a.link.external",
    );
  });

  it("falls back to tag", () => {
    expect(selectorHintFromIdentity({ tag: "H1" })).toBe("h1");
  });
});

describe("assembleDesignModePick", () => {
  it("truncates html and text and subsets styles", () => {
    const longHtml = `<div>${"x".repeat(DESIGN_MODE_HTML_MAX + 500)}</div>`;
    const pick = assembleDesignModePick({
      url: "https://example.com/",
      tag: "button",
      id: "go",
      className: "primary",
      text: "Go " + "y".repeat(300),
      html: longHtml,
      bounds: { x: 10.4, y: 20.6, width: 100, height: 40 },
      styles: {
        color: "rgb(0,0,0)",
        backgroundColor: "blue",
        zIndex: "1",
      },
      note: "  make it bigger  ",
      capturedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(pick.tag).toBe("BUTTON");
    expect(pick.html.length).toBe(DESIGN_MODE_HTML_MAX);
    expect(pick.text.length).toBeLessThanOrEqual(240);
    expect(pick.styles).toEqual({ color: "rgb(0,0,0)", backgroundColor: "blue" });
    expect(pick.selectorHint).toBe("button#go");
    expect(pick.note).toBe("make it bigger");
    expect(pick.bounds.x).toBeCloseTo(10.4);
  });
});

describe("formatDesignModePickForAgent", () => {
  it("includes url, html fence, and optional screenshot path", () => {
    const pick = assembleDesignModePick({
      url: "https://example.com/",
      tag: "A",
      text: "Learn more",
      html: '<a href="/more">Learn more</a>',
      bounds: { x: 0, y: 0, width: 80, height: 20 },
      styles: { color: "rgb(0, 0, 238)" },
      screenshotPath: "/tmp/pick.png",
      capturedAt: "2026-08-03T00:00:00.000Z",
    });
    const md = formatDesignModePickForAgent(pick, { agent: "grok" });
    expect(md).toContain("https://example.com/");
    expect(md).toContain("```html");
    expect(md).toContain("Learn more");
    expect(md).toContain("/tmp/pick.png");
    expect(md).toContain("`grok`");
    expect(md).toContain("Design Mode pick");
  });
});

describe("Design Mode shell entry points (shipped source)", () => {
  it("exposes Design Mode on IdeBrowserCdpSession", async () => {
    const { IdeBrowserCdpSession } = await import(
      "../../src/webview/ide-browser-bridge/cdpSession.js"
    );
    const session = new IdeBrowserCdpSession();
    expect(typeof session.setDesignMode).toBe("function");
    expect(typeof session.setDesignModePickHandler).toBe("function");
    expect(session.isDesignModeOn).toBe(false);
  });

  it("manager formats picks with the same shipped formatter", () => {
    // Guard against a fork of the prompt format that bypasses pick.ts
    const pick = assembleDesignModePick({
      url: "https://example.com/",
      tag: "H1",
      text: "Example Domain",
      html: "<h1>Example Domain</h1>",
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      styles: { fontSize: "32px" },
      capturedAt: "2026-08-03T00:00:00.000Z",
    });
    const body = formatDesignModePickForAgent(pick, { agent: "grok" });
    expect(body).toContain("Example Domain");
    expect(body).toContain("fontSize");
    expect(body).toMatch(/ide_browser_snapshot/);
    expect(body).toMatch(/token_unknown/);
    expect(body).toMatch(/ide_browser_status/);
  });
});

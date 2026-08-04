import { describe, expect, it } from "vitest";
import { mapDisplayClickToViewport } from "../../src/webview/ide-browser-proto/coords.js";
import { formatPickForAgent, type IdeBrowserPickPayload } from "../../src/webview/ide-browser-proto/types.js";

describe("ide-browser-proto coords (Option A)", () => {
  it("maps center click when display matches css 1:1", () => {
    const p = mapDisplayClickToViewport({
      x: 100,
      y: 50,
      displayW: 200,
      displayH: 100,
      cssW: 200,
      cssH: 100,
    });
    expect(p).toEqual({ x: 100, y: 50 });
  });

  it("accounts for letterboxing on wide display (object-fit contain)", () => {
    // css 200x100, display 400x100 → scale=1, content 200x100, offsetX=100
    const p = mapDisplayClickToViewport({
      x: 100 + 50,
      y: 25,
      displayW: 400,
      displayH: 100,
      cssW: 200,
      cssH: 100,
    });
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(50, 5);
    expect(p!.y).toBeCloseTo(25, 5);
  });

  it("returns null for click in letterbox gutter", () => {
    const p = mapDisplayClickToViewport({
      x: 10,
      y: 50,
      displayW: 400,
      displayH: 100,
      cssW: 200,
      cssH: 100,
    });
    expect(p).toBeNull();
  });

  it("scales when display is smaller than css", () => {
    // css 1000x500, display 500x250 → scale 0.5
    const p = mapDisplayClickToViewport({
      x: 250,
      y: 125,
      displayW: 500,
      displayH: 250,
      cssW: 1000,
      cssH: 500,
    });
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(500, 5);
    expect(p!.y).toBeCloseTo(250, 5);
  });
});

describe("ide-browser-proto formatPickForAgent", () => {
  it("includes url and truncated html fence", () => {
    const pick: IdeBrowserPickPayload = {
      url: "https://example.com/",
      tag: "BUTTON",
      id: "go",
      className: "primary",
      text: "Go",
      html: "<button id=\"go\">Go</button>",
      bounds: { x: 1, y: 2, w: 3, h: 4 },
      styles: { color: "rgb(0,0,0)" },
      capturedAt: "2026-08-03T00:00:00.000Z",
    };
    const s = formatPickForAgent(pick);
    expect(s).toContain("https://example.com/");
    expect(s).toContain("<button");
    expect(s).toContain("IDE Browser pick");
  });
});

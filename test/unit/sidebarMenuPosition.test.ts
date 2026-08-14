import { describe, expect, it } from "vitest";
import { placeMoreMenu } from "@tachyon/webview-ui/webview/sidebar/menuPosition";

describe("placeMoreMenu", () => {
  it("keeps a menu opened near the top-left click point", () => {
    expect(placeMoreMenu({
      anchorX: 80,
      anchorY: 40,
      viewportWidth: 320,
      viewportHeight: 240,
      menuWidth: 180,
      menuHeight: 100,
    })).toEqual({ left: 72, top: 40 });
  });

  it("flips left when the requested x would overflow the right edge", () => {
    expect(placeMoreMenu({
      anchorX: 308,
      anchorY: 40,
      viewportWidth: 320,
      viewportHeight: 240,
      menuWidth: 220,
      menuHeight: 100,
    })).toEqual({ left: 94, top: 40 });
  });

  it("flips above the trigger when the menu would overflow the bottom edge", () => {
    expect(placeMoreMenu({
      anchorX: 120,
      anchorY: 228,
      viewportWidth: 320,
      viewportHeight: 240,
      menuWidth: 180,
      menuHeight: 110,
    })).toEqual({ left: 112, top: 124 });
  });

  it("sidebar context menu clamps to the viewport", () => {
    expect(placeMoreMenu({
      anchorX: 4,
      anchorY: 4,
      viewportWidth: 160,
      viewportHeight: 100,
      menuWidth: 220,
      menuHeight: 140,
    })).toEqual({ left: 6, top: 6 });
  });
});

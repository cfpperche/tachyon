import { describe, it, expect } from "vitest";
import {
  clampScale,
  fitScale,
  fitWidthScale,
  clampPan,
  zoomAtPoint,
  panBy,
  canPan,
  wheelPanConsume,
  formatScalePercent,
  initialTransform,
  reset100,
  fitTransform,
  MIN_SCALE,
  MAX_SCALE,
} from "@tachyon/webview-ui/webview/activity/mermaidViewport.js";

describe("mermaidViewport (spec 374)", () => {
  it("clampScale bounds and rejects non-finite", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1)).toBe(1);
    expect(clampScale(Number.NaN)).toBe(1);
  });

  it("fitScale never upscales past 1", () => {
    expect(fitScale({ w: 400, h: 300 }, { w: 100, h: 80 })).toBe(1);
    expect(fitScale({ w: 200, h: 100 }, { w: 400, h: 100 })).toBe(0.5);
    expect(fitScale({ w: 200, h: 50 }, { w: 200, h: 200 })).toBe(0.25);
  });

  it("fitWidthScale matches historical max-width framing", () => {
    expect(fitWidthScale(300, 100)).toBe(1);
    expect(fitWidthScale(200, 400)).toBe(0.5);
  });

  it("initialTransform opens at fit-width only (readable; does not micro-fit height)", () => {
    // t-6fb08d — default is for reading; full-box shrink is Fit (fitTransform), not open.
    const wide = initialTransform({ w: 200, h: 500 }, { w: 400, h: 100 });
    expect(wide.scale).toBe(0.5);

    const tall = initialTransform({ w: 400, h: 100 }, { w: 200, h: 400 });
    // width allows 1; height overflow is pan, not shrink-to-min-height microscopic fit
    expect(tall.scale).toBe(1);

    // Large flowchart into a short first-layout viewport must not collapse to MIN_SCALE
    const microRisk = initialTransform({ w: 600, h: 80 }, { w: 2000, h: 1200 });
    expect(microRisk.scale).toBe(0.3); // fit-width only
    expect(microRisk.scale).toBeGreaterThan(MIN_SCALE);
  });

  it("fitTransform still full-fits for the explicit Fit control", () => {
    const t = fitTransform({ w: 400, h: 100 }, { w: 200, h: 400 });
    expect(t.scale).toBe(0.25);
  });

  it("reset100 is natural size centered when smaller than viewport", () => {
    const t = reset100({ w: 400, h: 300 }, { w: 100, h: 50 });
    expect(t.scale).toBe(1);
    expect(t.tx).toBe(150);
    expect(t.ty).toBe(125);
  });

  it("fitTransform shrinks large content into viewport", () => {
    const t = fitTransform({ w: 200, h: 200 }, { w: 400, h: 100 });
    expect(t.scale).toBe(0.5);
  });

  it("zoomAtPoint keeps the content point under the cursor stable", () => {
    const viewport = { w: 200, h: 200 };
    const content = { w: 200, h: 200 };
    const start = { scale: 1, tx: 0, ty: 0 };
    const origin = { x: 50, y: 50 };
    const next = zoomAtPoint(start, 2, origin, viewport, content);
    // content point (50,50) should still map to origin after zoom
    expect(origin.x - next.tx).toBeCloseTo(50 * next.scale, 5);
    expect(origin.y - next.ty).toBeCloseTo(50 * next.scale, 5);
    expect(next.scale).toBe(2);
  });

  it("clampPan centers when content is smaller and clamps when larger", () => {
    const small = clampPan({ scale: 1, tx: 0, ty: 0 }, { w: 300, h: 300 }, { w: 100, h: 100 });
    expect(small.tx).toBe(100);
    expect(small.ty).toBe(100);

    const big = clampPan({ scale: 2, tx: 50, ty: -500 }, { w: 100, h: 100 }, { w: 100, h: 100 });
    // scaled 200x200 in 100x100 → tx in [-100, 0], ty in [-100, 0]
    expect(big.tx).toBe(0); // 50 clamped to 0
    expect(big.ty).toBe(-100);
  });

  it("panBy moves then clamps", () => {
    const t = panBy({ scale: 2, tx: 0, ty: 0 }, -10, -10, { w: 100, h: 100 }, { w: 100, h: 100 });
    expect(t.tx).toBe(-10);
    expect(t.ty).toBe(-10);
  });

  it("canPan only when overflow exists", () => {
    expect(canPan({ scale: 1, tx: 0, ty: 0 }, { w: 200, h: 200 }, { w: 100, h: 100 })).toBe(false);
    expect(canPan({ scale: 3, tx: 0, ty: 0 }, { w: 200, h: 200 }, { w: 100, h: 100 })).toBe(true);
  });

  it("wheelPanConsume passes through when not pannable or at edge", () => {
    const vp = { w: 200, h: 200 };
    const ct = { w: 100, h: 100 };
    const idle = wheelPanConsume({ scale: 1, tx: 50, ty: 50 }, 40, vp, ct);
    expect(idle.consumed).toBe(false);

    // zoomed, room to pan down (negative ty direction via positive deltaY)
    const zoomed = { scale: 2, tx: 0, ty: 0 }; // content 200x200 in 200x200 — wait 100*2=200, no overflow
    const edge = wheelPanConsume(zoomed, 40, vp, { w: 100, h: 100 });
    expect(edge.consumed).toBe(false);

    const pannable = wheelPanConsume({ scale: 3, tx: 0, ty: 0 }, 40, vp, { w: 100, h: 100 });
    expect(pannable.consumed).toBe(true);
    expect(pannable.next.ty).toBeLessThan(0);

    // at bottom edge, further scroll down not consumed
    const atBottom = clampPan({ scale: 3, tx: 0, ty: -999 }, vp, { w: 100, h: 100 });
    const pass = wheelPanConsume(atBottom, 40, vp, { w: 100, h: 100 });
    expect(pass.consumed).toBe(false);
  });

  it("formatScalePercent rounds", () => {
    expect(formatScalePercent(1)).toBe("100%");
    expect(formatScalePercent(1.15)).toBe("115%");
    expect(formatScalePercent(0.5)).toBe("50%");
  });
});

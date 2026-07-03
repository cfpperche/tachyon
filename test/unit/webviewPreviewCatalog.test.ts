import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ROUTES, buildCatalog } from "../../scripts/webview-preview/routes.js";
import { WEBVIEW_SURFACES } from "../../src/webview/surfaces.js";

// spec 278 Lane D — the route CATALOG smoke. routes.json is GENERATED from the route table (buildCatalog); this
// test keeps the committed file in sync AND asserts every catalog route is structurally renderable (its view +
// fixture + bundle resolve). The actual non-empty-root render is proven by the live agent-browser sweep at
// delivery (a browser/server integration, not a unit test). If buildCatalog changes, regenerate routes.json.

const committed = JSON.parse(readFileSync("scripts/webview-preview/routes.json", "utf8"));
const esbuild = readFileSync("esbuild.mjs", "utf8");

describe("webview preview route catalog (spec 278)", () => {
  it("the committed routes.json equals buildCatalog() (generated, not hand-maintained)", () => {
    expect(committed).toEqual(buildCatalog());
  });

  it("every catalog route resolves to a real view + fixture + esbuild bundle", () => {
    for (const e of buildCatalog()) {
      const route = ROUTES[e.view];
      expect(route, `catalog view '${e.view}' not in the route table`).toBeTruthy();
      expect(route.fixtures[e.fixture], `fixture '${e.fixture}' missing for view '${e.view}'`).toBeTruthy();
      expect(esbuild.includes(route.bundle.replace(/^\//, "")), `no esbuild entry for ${route.bundle}`).toBe(true);
      expect(e.url).toBe(`/scripts/webview-preview/index.html?view=${e.view}&fixture=${e.fixture}`);
      expect(e.frame).toEqual(route.frame);
    }
  });

  it(`the catalog spans ALL ${WEBVIEW_SURFACES.length} webview surfaces (every converted view is harness-reachable)`, () => {
    const catalogViews = new Set(buildCatalog().map((e) => e.view));
    const surfaceViews = WEBVIEW_SURFACES.map((s) => s.view);
    for (const v of surfaceViews) expect(catalogViews.has(v), `surface '${v}' has no harness route`).toBe(true);
    expect(catalogViews.size).toBe(surfaceViews.length); // no extra/missing
  });
});

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { ROUTES, PREVIEW_ROUTE_OPTOUTS, buildCatalog } from "../../scripts/webview-preview/routes.js";
import { WEBVIEW_SURFACES } from "../../src/webview/surfaces.js";
import { buildsWebviewEntry } from "../helpers/webviewEntries.js";
import { nonEmpty } from "../helpers/repositorySourceScan.js";

// spec 278 Lane D — the route CATALOG smoke. routes.json is GENERATED from the route table (buildCatalog); this
// test keeps the committed file in sync AND asserts every catalog route is structurally renderable (its view +
// fixture + bundle resolve). The actual non-empty-root render is proven by the live agent-browser sweep at
// delivery (a browser/server integration, not a unit test). If buildCatalog changes, regenerate routes.json.

const committed = JSON.parse(readFileSync("scripts/webview-preview/routes.json", "utf8"));
const esbuild = readFileSync("esbuild.mjs", "utf8");
const convertedSurfaces = WEBVIEW_SURFACES.filter((s) => s.converted);

describe("webview preview route catalog (spec 278)", () => {
  it("the committed routes.json equals buildCatalog() (generated, not hand-maintained)", () => {
    expect(committed).toEqual(buildCatalog());
  });

  it("every catalog route resolves to a real view + fixture + esbuild bundle", () => {
    for (const e of buildCatalog()) {
      const route = ROUTES[e.view];
      expect(route, `catalog view '${e.view}' not in the route table`).toBeTruthy();
      expect(route.fixtures[e.fixture], `fixture '${e.fixture}' missing for view '${e.view}'`).toBeTruthy();
      // SDD 485 C2 — the standalone apps are entries of one splitting invocation (outdir + entryNames), so
      // their output path is never a literal in esbuild.mjs; `buildsWebviewEntry` knows both build shapes.
      const view = /^\/dist\/webview\/(.+)\.js$/.exec(route.bundle)?.[1] ?? "";
      expect(buildsWebviewEntry(esbuild, view), `no esbuild entry for ${route.bundle}`).toBe(true);
      expect(e.url).toBe(`/scripts/webview-preview/index.html?view=${e.view}&fixture=${e.fixture}`);
      expect(e.frame).toEqual(route.frame);
    }
  });

  it("the webview surface manifest includes every converted shell host", () => {
    const manifestHosts = new Set(WEBVIEW_SURFACES.map((s) => s.hostFile));
    const convertedShellHosts = nonEmpty(readdirSync("apps/vscode-extension/src/webview")
      .filter((name) => /(?:Panel|Prototype|Form|Inspector)\.ts$/.test(name))
      .map((name) => `apps/vscode-extension/src/webview/${name}`)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return source.includes("renderWebviewShell(");
      }), "converted webview shell-host scan");
    for (const host of convertedShellHosts) {
      expect(manifestHosts.has(host), `converted webview host '${host}' is missing from WEBVIEW_SURFACES`).toBe(true);
    }
  });

  it(`the catalog spans ALL ${convertedSurfaces.length} converted webview surfaces unless explicitly opted out`, () => {
    const catalogViews = new Set(buildCatalog().map((e) => e.view));
    const surfaceViews = new Set(convertedSurfaces.map((s) => s.view));
    for (const [view, reason] of Object.entries(PREVIEW_ROUTE_OPTOUTS)) {
      expect(
        surfaceViews.has(view) || existsSync(`packages/webview-ui/src/webview/${view}`),
        `preview opt-out '${view}' is neither a converted surface nor a webview renderer`,
      ).toBe(true);
      expect(reason.trim().length, `preview opt-out '${view}' needs a non-empty reason`).toBeGreaterThan(0);
    }
    for (const v of surfaceViews) {
      if (PREVIEW_ROUTE_OPTOUTS[v]) continue;
      expect(catalogViews.has(v), `surface '${v}' has no harness route`).toBe(true);
    }
    for (const v of catalogViews) {
      expect(surfaceViews.has(v), `route '${v}' has no WEBVIEW_SURFACES entry`).toBe(true);
    }
  });
});
